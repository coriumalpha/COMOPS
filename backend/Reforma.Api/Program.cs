using System.ComponentModel.DataAnnotations;
using System.Globalization;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddDbContext<AppDbContext>(options =>
{
    var cs = builder.Configuration.GetConnectionString("Default")
        ?? Environment.GetEnvironmentVariable("CONNECTION_STRINGS__DEFAULT")
        ?? "Host=localhost;Port=5432;Database=reforma;Username=reforma;Password=reforma";
    options.UseNpgsql(cs);
});

builder.Services.AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme)
    .AddCookie(options =>
    {
        options.Cookie.Name = "reforma_session";
        options.Cookie.HttpOnly = true;
        options.Cookie.SameSite = SameSiteMode.Strict;
        options.Cookie.SecurePolicy = CookieSecurePolicy.SameAsRequest;
        options.SlidingExpiration = true;
        options.ExpireTimeSpan = TimeSpan.FromHours(12);
        options.Events.OnRedirectToLogin = ctx =>
        {
            ctx.Response.StatusCode = StatusCodes.Status401Unauthorized;
            return Task.CompletedTask;
        };
    });
builder.Services.AddAuthorization();
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();
builder.Services.AddScoped<IDocumentStorage, LocalDocumentStorage>();
builder.Services.AddHostedService<AlertRefreshWorker>();
builder.Services.Configure<FormOptions>(options => options.MultipartBodyLengthLimit = 25 * 1024 * 1024);

var corsOrigins = (Environment.GetEnvironmentVariable("CORS_ORIGINS") ?? "http://localhost:5173,http://localhost:8080")
    .Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
builder.Services.AddCors(options => options.AddPolicy("frontend", policy => policy.WithOrigins(corsOrigins).AllowCredentials().AllowAnyHeader().AllowAnyMethod()));

var app = builder.Build();

app.UseExceptionHandler(errorApp =>
{
    errorApp.Run(async context =>
    {
        context.Response.StatusCode = StatusCodes.Status500InternalServerError;
        context.Response.ContentType = "application/json; charset=utf-8";
        await context.Response.WriteAsJsonAsync(new { error = "Error interno", traceId = context.TraceIdentifier });
    });
});

app.Use(async (ctx, next) =>
{
    ctx.Response.Headers.TryAdd("X-Content-Type-Options", "nosniff");
    ctx.Response.Headers.TryAdd("X-Frame-Options", "DENY");
    ctx.Response.Headers.TryAdd("Referrer-Policy", "same-origin");
    await next();
});
app.UseCors("frontend");
app.UseAuthentication();
app.UseAuthorization();

if (app.Environment.IsDevelopment())
{
    app.UseSwagger();
    app.UseSwaggerUI();
}

using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
    await db.Database.MigrateAsync();
    await SeedData.EnsureAsync(db);
}

var api = app.MapGroup("/api");

api.MapGet("/health", () => Results.Ok(new { status = "ok", utc = DateTimeOffset.UtcNow }));

api.MapPost("/auth/login", async (LoginRequest request, AppDbContext db, HttpContext ctx) =>
{
    var user = await db.Users.SingleOrDefaultAsync(u => u.Email == request.Email.ToLower());
    if (user is null || !PasswordHasher.Verify(request.Password, user.PasswordHash))
        return Results.Unauthorized();
    var claims = new[] { new Claim(ClaimTypes.NameIdentifier, user.Id.ToString()), new Claim(ClaimTypes.Email, user.Email), new Claim(ClaimTypes.Name, user.DisplayName) };
    await ctx.SignInAsync(CookieAuthenticationDefaults.AuthenticationScheme, new ClaimsPrincipal(new ClaimsIdentity(claims, CookieAuthenticationDefaults.AuthenticationScheme)));
    return Results.Ok(new UserDto(user.Id, user.Email, user.DisplayName));
});

api.MapPost("/auth/logout", async (HttpContext ctx) =>
{
    await ctx.SignOutAsync();
    return Results.NoContent();
}).RequireAuthorization();

api.MapGet("/auth/me", async (AppDbContext db, ClaimsPrincipal user) =>
{
    var id = user.UserId();
    var entity = await db.Users.FindAsync(id);
    return entity is null ? Results.Unauthorized() : Results.Ok(new UserDto(entity.Id, entity.Email, entity.DisplayName));
}).RequireAuthorization();

api.MapGet("/dashboard", async (AppDbContext db) =>
{
    var project = await db.Projects.OrderBy(p => p.Id).FirstAsync();
    var now = DateTimeOffset.UtcNow;
    var tasks = await db.Tasks.Where(t => t.ProjectId == project.Id).ToListAsync();
    var requests = await db.BudgetRequests.Where(r => r.ProjectId == project.Id).ToListAsync();
    var quotes = await db.Quotes.Where(q => q.ProjectId == project.Id).ToListAsync();
    var invoices = await db.Invoices.Include(i => i.Payments).Where(i => i.ProjectId == project.Id).ToListAsync();
    var workItems = await db.WorkItems.Where(w => w.ProjectId == project.Id).ToListAsync();
    var economy = EconomyCalculator.ProjectSummary(project, workItems, quotes, invoices);
    return Results.Ok(new
    {
        project,
        economy,
        overdueTasks = tasks.Count(t => DomainRules.IsTaskOverdue(t, now)),
        dueToday = tasks.Count(t => DomainRules.IsTaskDueToday(t, now, "Europe/Madrid")),
        overdueBudgetRequests = requests.Count(r => DomainRules.IsBudgetRequestOverdue(r, now)),
        unpaidInvoices = invoices.Count(i => EconomyCalculator.InvoiceBalance(i).Pending > 0),
        upcoming = await db.Appointments.Where(a => a.ProjectId == project.Id && a.StartUtc >= now && a.StartUtc <= now.AddDays(7)).OrderBy(a => a.StartUtc).Take(6).ToListAsync(),
        alerts = await db.Alerts.Where(a => a.ProjectId == project.Id && !a.Resolved).OrderByDescending(a => a.Severity).ThenBy(a => a.DueUtc).Take(12).ToListAsync(),
        timeline = await db.ActivityEvents.Where(a => a.ProjectId == project.Id).OrderByDescending(a => a.OccurredAtUtc).Take(12).ToListAsync()
    });
}).RequireAuthorization();

api.MapGet("/projects", async (AppDbContext db) => Results.Ok(await db.Projects.OrderBy(p => p.Name).ToListAsync())).RequireAuthorization();
api.MapGet("/projects/{id:int}", async (int id, AppDbContext db) => await db.Projects.FindAsync(id) is { } p ? Results.Ok(p) : Results.NotFound()).RequireAuthorization();
api.MapPost("/projects", async (ProjectInput input, AppDbContext db, ClaimsPrincipal user) =>
{
    var project = input.ToProject();
    db.Projects.Add(project);
    await db.SaveChangesAsync();
    await Activity.Record(db, project.Id, "Project", project.Id, "Proyecto creado", project.Name, user.UserId());
    return Results.Created($"/api/projects/{project.Id}", project);
}).RequireAuthorization();
api.MapPut("/projects/{id:int}", async (int id, ProjectInput input, AppDbContext db, ClaimsPrincipal user) =>
{
    var project = await db.Projects.FindAsync(id);
    if (project is null) return Results.NotFound();
    project.Name = input.Name;
    project.Description = input.Description;
    project.Location = input.Location;
    project.Status = input.Status;
    project.TargetBudget = input.TargetBudget;
    project.ContingencyFund = input.ContingencyFund;
    project.Notes = input.Notes;
    project.Tags = input.Tags ?? [];
    project.UpdatedAtUtc = DateTimeOffset.UtcNow;
    await db.SaveChangesAsync();
    await Activity.Record(db, project.Id, "Project", project.Id, "Proyecto actualizado", project.Name, user.UserId());
    return Results.Ok(project);
}).RequireAuthorization();

api.MapGet("/work-items", async (int? projectId, AppDbContext db) =>
{
    var query = db.WorkItems.Include(w => w.DependsOn).AsQueryable();
    if (projectId is not null) query = query.Where(w => w.ProjectId == projectId);
    var rows = await query.OrderBy(w => w.Title).ToListAsync();
    return Results.Ok(rows.Select(w => new
    {
        w.Id,
        w.ProjectId,
        w.Title,
        w.Description,
        w.Category,
        w.Status,
        w.Priority,
        w.TargetCost,
        w.EstimatedCost,
        w.CommittedCost,
        w.InvoicedCost,
        w.PaidCost,
        dependsOn = w.DependsOn.Select(d => d.DependsOnWorkItemId).ToArray()
    }));
}).RequireAuthorization();
api.MapPost("/work-items", async (WorkItemInput input, AppDbContext db, ClaimsPrincipal user) =>
{
    var item = input.ToWorkItem();
    db.WorkItems.Add(item);
    await db.SaveChangesAsync();
    if (input.DependsOnWorkItemId is int dep)
    {
        if (await DomainRules.WouldCreateWorkItemCycle(db, item.Id, dep)) return Results.BadRequest(new { error = "Dependencia cíclica" });
        db.WorkItemDependencies.Add(new WorkItemDependency { WorkItemId = item.Id, DependsOnWorkItemId = dep });
    }
    await db.SaveChangesAsync();
    await Activity.Record(db, item.ProjectId, "WorkItem", item.Id, "Partida creada", item.Title, user.UserId());
    return Results.Created($"/api/work-items/{item.Id}", item);
}).RequireAuthorization();
api.MapPut("/work-items/{id:int}", async (int id, WorkItemInput input, AppDbContext db, ClaimsPrincipal user) =>
{
    var item = await db.WorkItems.Include(w => w.DependsOn).FirstOrDefaultAsync(w => w.Id == id);
    if (item is null) return Results.NotFound();
    item.Title = input.Title;
    item.Description = input.Description;
    item.Category = input.Category;
    item.Status = input.Status;
    item.Priority = input.Priority;
    item.TargetCost = input.TargetCost;
    item.EstimatedCost = input.EstimatedCost;
    db.WorkItemDependencies.RemoveRange(item.DependsOn);
    if (input.DependsOnWorkItemId is int dep)
    {
        if (dep == id || await DomainRules.WouldCreateWorkItemCycle(db, id, dep)) return Results.BadRequest(new { error = "Dependencia cíclica" });
        db.WorkItemDependencies.Add(new WorkItemDependency { WorkItemId = id, DependsOnWorkItemId = dep });
    }
    await db.SaveChangesAsync();
    await Activity.Record(db, item.ProjectId, "WorkItem", item.Id, "Partida actualizada", item.Title, user.UserId());
    return Results.Ok(item);
}).RequireAuthorization();
api.MapPatch("/work-items/{id:int}/status", async (int id, WorkItemStatusUpdate input, AppDbContext db, ClaimsPrincipal user) =>
{
    var item = await db.WorkItems.FindAsync(id);
    if (item is null) return Results.NotFound();
    var before = item.Status;
    item.Status = input.Status;
    await db.SaveChangesAsync();
    await Activity.Record(db, item.ProjectId, "WorkItem", item.Id, "Estado de partida actualizado", $"{before} -> {item.Status}: {item.Title}", user.UserId());
    await AlertService.RefreshAsync(db);
    return Results.Ok(item);
}).RequireAuthorization();
api.MapDelete("/work-items/{id:int}", async (int id, AppDbContext db, ClaimsPrincipal user) =>
{
    var item = await db.WorkItems.FindAsync(id);
    if (item is null) return Results.NotFound();
    var hasRelations =
        await db.WorkItemDependencies.AnyAsync(d => d.WorkItemId == id || d.DependsOnWorkItemId == id) ||
        await db.WorkItemCommunications.AnyAsync(x => x.WorkItemId == id) ||
        await db.WorkItemContacts.AnyAsync(x => x.WorkItemId == id) ||
        await db.QuoteLines.AnyAsync(x => x.WorkItemId == id) ||
        await DomainRules.HasEntityLinks(db, "WorkItem", id);
    if (hasRelations) return Results.Conflict(new { error = "La partida tiene relaciones. Cancélala o elimina primero sus relaciones explícitas." });
    db.WorkItems.Remove(item);
    await Activity.Record(db, item.ProjectId, "WorkItem", item.Id, "Partida eliminada", item.Title, user.UserId());
    await db.SaveChangesAsync();
    return Results.NoContent();
}).RequireAuthorization();

api.MapGet("/contacts", async (int? projectId, AppDbContext db) =>
{
    var query = db.Contacts.AsQueryable();
    if (projectId is not null) query = query.Where(c => c.ProjectId == projectId);
    return Results.Ok(await query.OrderBy(c => c.Name).ToListAsync());
}).RequireAuthorization();
api.MapGet("/contacts/{id:int}", async (int id, AppDbContext db) =>
{
    var contact = await db.Contacts.FindAsync(id);
    if (contact is null) return Results.NotFound();
    var stats = await Stats.ContactStats(db, id);
    return Results.Ok(new { contact, stats });
}).RequireAuthorization();
api.MapPost("/contacts", async (ContactInput input, AppDbContext db, ClaimsPrincipal user) =>
{
    var contact = input.ToContact();
    db.Contacts.Add(contact);
    await db.SaveChangesAsync();
    await Activity.Record(db, contact.ProjectId, "Contact", contact.Id, "Contacto creado", contact.DisplayName, user.UserId());
    return Results.Created($"/api/contacts/{contact.Id}", contact);
}).RequireAuthorization();
api.MapPut("/contacts/{id:int}", async (int id, ContactInput input, AppDbContext db, ClaimsPrincipal user) =>
{
    var contact = await db.Contacts.FindAsync(id);
    if (contact is null) return Results.NotFound();
    contact.Name = input.Name;
    contact.Surname = input.Surname;
    contact.CompanyName = input.CompanyName;
    contact.Type = input.Type;
    contact.Trade = input.Trade;
    contact.Phone = input.Phone;
    contact.Email = input.Email;
    contact.Status = input.Status;
    contact.Notes = input.Notes;
    contact.LastContactUtc = DateTimeOffset.UtcNow;
    await db.SaveChangesAsync();
    await Activity.Record(db, contact.ProjectId, "Contact", contact.Id, "Contacto actualizado", contact.DisplayName, user.UserId());
    return Results.Ok(contact);
}).RequireAuthorization();
api.MapDelete("/contacts/{id:int}", async (int id, AppDbContext db, ClaimsPrincipal user) =>
{
    var contact = await db.Contacts.FindAsync(id);
    if (contact is null) return Results.NotFound();
    if (await DomainRules.HasContactRelations(db, id)) return Results.Conflict(new { error = "El contacto tiene actividad relacionada. Descártalo o finalízalo en lugar de eliminarlo." });
    db.Contacts.Remove(contact);
    await Activity.Record(db, contact.ProjectId, "Contact", contact.Id, "Contacto eliminado", contact.DisplayName, user.UserId());
    await db.SaveChangesAsync();
    return Results.NoContent();
}).RequireAuthorization();

api.MapGet("/communications", async (int? projectId, AppDbContext db) =>
{
    var query = db.Communications.Include(c => c.Contact).AsQueryable();
    if (projectId is not null) query = query.Where(c => c.ProjectId == projectId);
    return Results.Ok(await query.OrderByDescending(c => c.OccurredAtUtc).ToListAsync());
}).RequireAuthorization();
api.MapPost("/communications", async (CommunicationInput input, AppDbContext db, ClaimsPrincipal user) =>
{
    var comm = input.ToCommunication(user.UserId());
    db.Communications.Add(comm);
    await db.SaveChangesAsync();
    foreach (var workItemId in input.WorkItemIds.Distinct()) db.WorkItemCommunications.Add(new WorkItemCommunication { WorkItemId = workItemId, CommunicationId = comm.Id });
    if (input.CreateFollowUpTask)
    {
        db.Tasks.Add(new TaskItem { ProjectId = comm.ProjectId, Title = input.FollowUpTitle ?? $"Seguimiento: {comm.Summary}", Status = TaskStatus.Pending, Priority = Priority.Normal, DueUtc = input.FollowUpDueUtc, ContactId = comm.ContactId, CreatedAtUtc = DateTimeOffset.UtcNow });
    }
    await Activity.Record(db, comm.ProjectId, "Communication", comm.Id, "Comunicación registrada", comm.Summary, user.UserId());
    await db.SaveChangesAsync();
    return Results.Created($"/api/communications/{comm.Id}", comm);
}).RequireAuthorization();

api.MapGet("/tasks", async (int? projectId, AppDbContext db) =>
{
    var query = db.Tasks.Include(t => t.Contact).Include(t => t.Category).AsQueryable();
    if (projectId is not null) query = query.Where(t => t.ProjectId == projectId);
    return Results.Ok(await query.OrderBy(t => t.ParentTaskId).ThenBy(t => t.SortOrder).ThenBy(t => t.Status).ThenBy(t => t.DueUtc).ToListAsync());
}).RequireAuthorization();
api.MapGet("/tasks/{id:int}", async (int id, AppDbContext db) =>
{
    var task = await db.Tasks.Include(t => t.Contact).Include(t => t.Category).FirstOrDefaultAsync(t => t.Id == id);
    return task is null ? Results.NotFound() : Results.Ok(task);
}).RequireAuthorization();
api.MapGet("/tasks/{id:int}/relations", async (int id, AppDbContext db) =>
{
    var task = await db.Tasks.FindAsync(id);
    if (task is null) return Results.NotFound();
    return Results.Ok(await TaskRelationReader.BuildAsync(db, task));
}).RequireAuthorization();
api.MapPost("/tasks", async (TaskInput input, AppDbContext db, ClaimsPrincipal user) =>
{
    var task = input.ToTask();
    var validation = await DomainRules.ValidateTaskAsync(db, task);
    if (validation is not null) return Results.BadRequest(new { error = validation });
    db.Tasks.Add(task);
    await db.SaveChangesAsync();
    await Activity.Record(db, task.ProjectId, "Task", task.Id, "Tarea creada", task.Title, user.UserId());
    return Results.Created($"/api/tasks/{task.Id}", task);
}).RequireAuthorization();
api.MapPut("/tasks/{id:int}", async (int id, TaskInput input, AppDbContext db, ClaimsPrincipal user) =>
{
    var task = await db.Tasks.FindAsync(id);
    if (task is null) return Results.NotFound();
    task.Title = input.Title;
    task.Description = input.Description;
    task.Status = input.Status;
    task.Priority = input.Priority;
    task.Responsible = input.Responsible;
    task.DueUtc = input.DueUtc?.ToUniversalTime();
    task.ContactId = input.ContactId;
    task.PrimaryWorkItemId = input.PrimaryWorkItemId;
    task.IssueId = input.IssueId;
    task.TaskType = input.TaskType;
    task.ParentTaskId = input.ParentTaskId;
    task.SortOrder = input.SortOrder;
    task.ProgressPercent = input.ProgressPercent;
    task.TimingKind = input.TimingKind;
    task.IsPlanningProvisional = input.IsPlanningProvisional;
    task.PlanningWarning = input.PlanningWarning;
    task.PlannedStartAt = input.PlannedStartAt?.ToUniversalTime();
    task.PlannedEndAt = input.PlannedEndAt?.ToUniversalTime();
    task.ActualStartAt = input.ActualStartAt?.ToUniversalTime();
    task.ActualEndAt = input.ActualEndAt?.ToUniversalTime();
    task.CategoryId = input.CategoryId;
    task.BlockingReason = input.Status == TaskStatus.Blocked ? input.BlockingReason : null;
    task.CompletedAtUtc = input.Status == TaskStatus.Completed ? DateTimeOffset.UtcNow : null;
    var validation = await DomainRules.ValidateTaskAsync(db, task);
    if (validation is not null) return Results.BadRequest(new { error = validation });
    await db.SaveChangesAsync();
    await Activity.Record(db, task.ProjectId, "Task", task.Id, "Tarea actualizada", task.Title, user.UserId());
    await AlertService.RefreshAsync(db);
    return Results.Ok(task);
}).RequireAuthorization();
api.MapPatch("/tasks/{id:int}/move", async (int id, TaskMoveInput input, AppDbContext db, ClaimsPrincipal user) =>
{
    var task = await db.Tasks.FindAsync(id);
    if (task is null) return Results.NotFound();
    if (input.ParentTaskId == id || await DomainRules.WouldCreateTaskHierarchyCycle(db, id, input.ParentTaskId)) return Results.BadRequest(new { error = "Jerarquía cíclica" });
    task.ParentTaskId = input.ParentTaskId;
    task.SortOrder = input.SortOrder;
    await db.SaveChangesAsync();
    await Activity.Record(db, task.ProjectId, "Task", task.Id, "Tarea movida", task.Title, user.UserId());
    return Results.Ok(task);
}).RequireAuthorization();
api.MapPatch("/tasks/{id:int}/type", async (int id, TaskTypeUpdate input, AppDbContext db, ClaimsPrincipal user) =>
{
    var task = await db.Tasks.FindAsync(id);
    if (task is null) return Results.NotFound();
    if (input.TaskType != TaskType.Epic && task.TaskType == TaskType.Epic && await db.Tasks.AnyAsync(t => t.ParentTaskId == id))
        return Results.Conflict(new { error = "No se puede convertir una épica con tareas hijas. Mueve primero esas tareas." });
    task.TaskType = input.TaskType;
    await db.SaveChangesAsync();
    await Activity.Record(db, task.ProjectId, "Task", task.Id, "Tipo de tarea actualizado", $"{task.Title}: {task.TaskType}", user.UserId());
    return Results.Ok(task);
}).RequireAuthorization();
api.MapPatch("/tasks/{id:int}/status", async (int id, TaskStatusUpdate input, AppDbContext db, ClaimsPrincipal user) =>
{
    var task = await db.Tasks.FindAsync(id);
    if (task is null) return Results.NotFound();
    var before = task.Status;
    task.Status = input.Status;
    task.BlockingReason = input.Status == TaskStatus.Blocked ? input.BlockingReason : null;
    task.CompletedAtUtc = input.Status == TaskStatus.Completed ? DateTimeOffset.UtcNow : null;
    await db.SaveChangesAsync();
    await Activity.Record(db, task.ProjectId, "Task", task.Id, "Estado de tarea actualizado", $"{before} -> {task.Status}: {task.Title}", user.UserId());
    await AlertService.RefreshAsync(db);
    return Results.Ok(task);
}).RequireAuthorization();
api.MapDelete("/tasks/{id:int}", async (int id, AppDbContext db, ClaimsPrincipal user) =>
{
    var task = await db.Tasks.FindAsync(id);
    if (task is null) return Results.NotFound();
    if (await db.Tasks.AnyAsync(t => t.ParentTaskId == id)) return Results.Conflict(new { error = "La tarea tiene tareas hijas. Muévelas antes de eliminarla." });
    if (await DomainRules.HasEntityLinks(db, "Task", id)) return Results.Conflict(new { error = "La tarea tiene relaciones explícitas. Elimina o cambia esas relaciones antes." });
    db.Tasks.Remove(task);
    await Activity.Record(db, task.ProjectId, "Task", task.Id, "Tarea eliminada", task.Title, user.UserId());
    await db.SaveChangesAsync();
    await AlertService.RefreshAsync(db);
    return Results.NoContent();
}).RequireAuthorization();
api.MapGet("/task-categories", async (int? projectId, AppDbContext db) =>
{
    var query = db.TaskCategories.AsQueryable();
    if (projectId is not null) query = query.Where(c => c.ProjectId == projectId);
    return Results.Ok(await query.OrderBy(c => c.SortOrder).ThenBy(c => c.Name).ToListAsync());
}).RequireAuthorization();
api.MapPost("/task-categories", async (TaskCategoryInput input, AppDbContext db) =>
{
    var category = new TaskCategory { ProjectId = input.ProjectId, Name = input.Name.Trim(), Color = input.Color, SortOrder = input.SortOrder };
    db.TaskCategories.Add(category);
    await db.SaveChangesAsync();
    return Results.Created($"/api/task-categories/{category.Id}", category);
}).RequireAuthorization();
api.MapPut("/task-categories/{id:int}", async (int id, TaskCategoryInput input, AppDbContext db) =>
{
    var category = await db.TaskCategories.FindAsync(id);
    if (category is null) return Results.NotFound();
    category.Name = input.Name.Trim();
    category.Color = input.Color;
    category.SortOrder = input.SortOrder;
    await db.SaveChangesAsync();
    return Results.Ok(category);
}).RequireAuthorization();
api.MapGet("/task-dependencies", async (int? projectId, AppDbContext db) =>
{
    var query = db.TaskDependencies.AsQueryable();
    if (projectId is not null) query = query.Where(d => d.ProjectId == projectId);
    return Results.Ok(await query.OrderBy(d => d.PredecessorTaskId).ToListAsync());
}).RequireAuthorization();
api.MapPost("/task-dependencies", async (TaskDependencyInput input, AppDbContext db) =>
{
    if (input.PredecessorTaskId == input.SuccessorTaskId || await DomainRules.WouldCreateTaskDependencyCycle(db, input.PredecessorTaskId, input.SuccessorTaskId))
        return Results.BadRequest(new { error = "Dependencia cíclica" });
    var dep = new TaskDependency { ProjectId = input.ProjectId, PredecessorTaskId = input.PredecessorTaskId, SuccessorTaskId = input.SuccessorTaskId, DependencyType = input.DependencyType };
    db.TaskDependencies.Add(dep);
    await db.SaveChangesAsync();
    return Results.Created($"/api/task-dependencies/{dep.Id}", dep);
}).RequireAuthorization();

api.MapGet("/appointments", async (int? projectId, AppDbContext db) =>
{
    var query = db.Appointments.AsQueryable();
    if (projectId is not null) query = query.Where(a => a.ProjectId == projectId);
    return Results.Ok(await query.OrderBy(a => a.StartUtc).ToListAsync());
}).RequireAuthorization();
api.MapPost("/appointments", async (AppointmentInput input, AppDbContext db, ClaimsPrincipal user) =>
{
    var entity = input.ToAppointment();
    db.Appointments.Add(entity);
    await db.SaveChangesAsync();
    await Activity.Record(db, entity.ProjectId, "Appointment", entity.Id, "Cita creada", entity.Title, user.UserId());
    return Results.Created($"/api/appointments/{entity.Id}", entity);
}).RequireAuthorization();
api.MapPut("/appointments/{id:int}", async (int id, AppointmentInput input, AppDbContext db, ClaimsPrincipal user) =>
{
    var entity = await db.Appointments.FindAsync(id);
    if (entity is null) return Results.NotFound();
    entity.Title = input.Title;
    entity.StartUtc = input.StartUtc.ToUniversalTime();
    entity.EndUtc = input.EndUtc?.ToUniversalTime();
    entity.Location = input.Location;
    entity.Participants = input.Participants;
    entity.Description = input.Description;
    entity.Status = input.Status;
    await db.SaveChangesAsync();
    await Activity.Record(db, entity.ProjectId, "Appointment", entity.Id, "Cita actualizada", entity.Title, user.UserId());
    await AlertService.RefreshAsync(db);
    return Results.Ok(entity);
}).RequireAuthorization();
api.MapDelete("/appointments/{id:int}", async (int id, AppDbContext db, ClaimsPrincipal user) =>
{
    var entity = await db.Appointments.FindAsync(id);
    if (entity is null) return Results.NotFound();
    if (await DomainRules.HasEntityLinks(db, "Appointment", id)) return Results.Conflict(new { error = "La cita tiene relaciones explícitas." });
    db.Appointments.Remove(entity);
    await Activity.Record(db, entity.ProjectId, "Appointment", entity.Id, "Cita eliminada", entity.Title, user.UserId());
    await db.SaveChangesAsync();
    await AlertService.RefreshAsync(db);
    return Results.NoContent();
}).RequireAuthorization();

api.MapGet("/interventions", async (int? projectId, AppDbContext db) =>
{
    var query = db.Interventions.Include(i => i.Provider).AsQueryable();
    if (projectId is not null) query = query.Where(i => i.ProjectId == projectId);
    return Results.Ok(await query.OrderBy(i => i.PlannedStartUtc).ToListAsync());
}).RequireAuthorization();
api.MapPost("/interventions", async (InterventionInput input, AppDbContext db, ClaimsPrincipal user) =>
{
    var entity = input.ToIntervention();
    db.Interventions.Add(entity);
    await db.SaveChangesAsync();
    await Activity.Record(db, entity.ProjectId, "Intervention", entity.Id, "Intervención creada", entity.Title, user.UserId());
    return Results.Created($"/api/interventions/{entity.Id}", entity);
}).RequireAuthorization();
api.MapPut("/interventions/{id:int}", async (int id, InterventionInput input, AppDbContext db, ClaimsPrincipal user) =>
{
    var entity = await db.Interventions.FindAsync(id);
    if (entity is null) return Results.NotFound();
    entity.Title = input.Title;
    entity.Description = input.Description;
    entity.ProviderId = input.ProviderId;
    entity.Status = input.Status;
    entity.PlannedStartUtc = input.PlannedStartUtc?.ToUniversalTime();
    entity.ExpectedCost = input.ExpectedCost;
    entity.AgreedCost = input.AgreedCost;
    await db.SaveChangesAsync();
    await Activity.Record(db, entity.ProjectId, "Intervention", entity.Id, "Intervención actualizada", entity.Title, user.UserId());
    await AlertService.RefreshAsync(db);
    return Results.Ok(entity);
}).RequireAuthorization();
api.MapDelete("/interventions/{id:int}", async (int id, AppDbContext db, ClaimsPrincipal user) =>
{
    var entity = await db.Interventions.FindAsync(id);
    if (entity is null) return Results.NotFound();
    if (await DomainRules.HasEntityLinks(db, "Intervention", id)) return Results.Conflict(new { error = "La intervención tiene relaciones explícitas." });
    db.Interventions.Remove(entity);
    await Activity.Record(db, entity.ProjectId, "Intervention", entity.Id, "Intervención eliminada", entity.Title, user.UserId());
    await db.SaveChangesAsync();
    await AlertService.RefreshAsync(db);
    return Results.NoContent();
}).RequireAuthorization();

api.MapGroup("/issues").MapCrud<Issue, IssueInput>((input) => input.ToIssue(), "Issue");
api.MapGroup("/requirements").MapCrud<Requirement, RequirementInput>((input) => input.ToRequirement(), "Requirement");
api.MapGroup("/decisions").MapCrud<Decision, DecisionInput>((input) => input.ToDecision(), "Decision");
api.MapGroup("/budget-requests").MapCrud<BudgetRequest, BudgetRequestInput>((input) => input.ToBudgetRequest(), "BudgetRequest");
api.MapPatch("/budget-requests/{id:int}/status", async (int id, BudgetRequestStatusUpdate input, AppDbContext db, ClaimsPrincipal user) =>
{
    var request = await db.BudgetRequests.FindAsync(id);
    if (request is null) return Results.NotFound();
    var before = request.Status;
    request.Status = input.Status;
    await db.SaveChangesAsync();
    await Activity.Record(db, request.ProjectId, "BudgetRequest", request.Id, "Estado de solicitud actualizado", $"{before} -> {request.Status}: {request.Title}", user.UserId());
    await AlertService.RefreshAsync(db);
    return Results.Ok(request);
}).RequireAuthorization();

api.MapGet("/quotes", async (int? projectId, AppDbContext db) =>
{
    var query = db.Quotes.Include(q => q.Provider).Include(q => q.Lines).AsQueryable();
    if (projectId is not null) query = query.Where(q => q.ProjectId == projectId);
    return Results.Ok(await query.OrderByDescending(q => q.ReceivedAtUtc).ToListAsync());
}).RequireAuthorization();
api.MapPost("/quotes", async (QuoteInput input, AppDbContext db, ClaimsPrincipal user) =>
{
    var quote = input.ToQuote();
    foreach (var line in quote.Lines) line.Recalculate();
    quote.Recalculate();
    db.Quotes.Add(quote);
    await db.SaveChangesAsync();
    await Activity.Record(db, quote.ProjectId, "Quote", quote.Id, "Presupuesto recibido", quote.Reference, user.UserId());
    return Results.Created($"/api/quotes/{quote.Id}", quote);
}).RequireAuthorization();
api.MapPut("/quotes/{id:int}", async (int id, QuoteInput input, AppDbContext db, ClaimsPrincipal user) =>
{
    var quote = await db.Quotes.Include(q => q.Lines).FirstOrDefaultAsync(q => q.Id == id);
    if (quote is null) return Results.NotFound();
    quote.Reference = input.Reference;
    quote.ProviderId = input.ProviderId;
    quote.IssuedAtUtc = input.IssuedAtUtc.ToUniversalTime();
    quote.ReceivedAtUtc = input.ReceivedAtUtc.ToUniversalTime();
    quote.ValidUntilUtc = input.ValidUntilUtc?.ToUniversalTime();
    quote.Status = input.Status;
    quote.Discounts = input.Discounts;
    quote.Currency = input.Currency;
    quote.EstimatedDuration = input.EstimatedDuration;
    quote.PaymentTerms = input.PaymentTerms;
    quote.Warranty = input.Warranty;
    quote.Exclusions = input.Exclusions;
    quote.Notes = input.Notes;
    quote.BudgetRequestId = input.BudgetRequestId;
    db.QuoteLines.RemoveRange(quote.Lines);
    quote.Lines = input.Lines.Select(l => new QuoteLine { Concept = l.Concept, Description = l.Description, Quantity = l.Quantity, Unit = l.Unit, UnitPrice = l.UnitPrice, TaxRate = l.TaxRate, Category = l.Category, WorkItemId = l.WorkItemId, Optional = l.Optional, InclusionStatus = l.InclusionStatus }).ToList();
    foreach (var line in quote.Lines) line.Recalculate();
    quote.Recalculate();
    await db.SaveChangesAsync();
    await Activity.Record(db, quote.ProjectId, "Quote", quote.Id, "Presupuesto actualizado", quote.Reference, user.UserId());
    return Results.Ok(quote);
}).RequireAuthorization();
api.MapDelete("/quotes/{id:int}", async (int id, AppDbContext db, ClaimsPrincipal user) =>
{
    var quote = await db.Quotes.Include(q => q.Lines).FirstOrDefaultAsync(q => q.Id == id);
    if (quote is null) return Results.NotFound();
    var hasRelations = await db.QuoteComparisonEntries.AnyAsync(x => x.QuoteId == id) || await db.Invoices.AnyAsync(x => x.QuoteId == id) || await DomainRules.HasEntityLinks(db, "Quote", id);
    if (hasRelations) return Results.Conflict(new { error = "El presupuesto tiene comparaciones, facturas o relaciones. Márcalo como rechazado/sustituido en vez de eliminarlo." });
    db.QuoteLines.RemoveRange(quote.Lines);
    db.Quotes.Remove(quote);
    await Activity.Record(db, quote.ProjectId, "Quote", quote.Id, "Presupuesto eliminado", quote.Reference, user.UserId());
    await db.SaveChangesAsync();
    return Results.NoContent();
}).RequireAuthorization();

api.MapGet("/comparisons", async (int? projectId, AppDbContext db) =>
{
    var query = db.QuoteComparisons.Include(c => c.Entries).ThenInclude(e => e.Quote).ThenInclude(q => q!.Provider).Include(c => c.Concepts).AsQueryable();
    if (projectId is not null) query = query.Where(c => c.ProjectId == projectId);
    var rows = await query.ToListAsync();
    return Results.Ok(rows.Select(ComparisonDto.From));
}).RequireAuthorization();
api.MapPost("/comparisons", async (ComparisonInput input, AppDbContext db, ClaimsPrincipal user) =>
{
    var comparison = input.ToComparison();
    db.QuoteComparisons.Add(comparison);
    await db.SaveChangesAsync();
    await Activity.Record(db, comparison.ProjectId, "QuoteComparison", comparison.Id, "Comparación creada", comparison.Title, user.UserId());
    return Results.Created($"/api/comparisons/{comparison.Id}", comparison);
}).RequireAuthorization();

api.MapGet("/invoices", async (int? projectId, AppDbContext db) =>
{
    var query = db.Invoices.Include(i => i.Supplier).Include(i => i.Lines).Include(i => i.Payments).AsQueryable();
    if (projectId is not null) query = query.Where(i => i.ProjectId == projectId);
    var invoices = await query.OrderByDescending(i => i.IssueDateUtc).ToListAsync();
    return Results.Ok(invoices.Select(ApiDtos.InvoiceRow));
}).RequireAuthorization();
api.MapPost("/invoices", async (InvoiceInput input, AppDbContext db, ClaimsPrincipal user) =>
{
    var invoice = input.ToInvoice();
    foreach (var line in invoice.Lines) line.Recalculate();
    invoice.Recalculate();
    db.Invoices.Add(invoice);
    await db.SaveChangesAsync();
    await Activity.Record(db, invoice.ProjectId, "Invoice", invoice.Id, "Factura registrada", invoice.Number, user.UserId());
    return Results.Created($"/api/invoices/{invoice.Id}", ApiDtos.Invoice(invoice));
}).RequireAuthorization();
api.MapPut("/invoices/{id:int}", async (int id, InvoiceInput input, AppDbContext db, ClaimsPrincipal user) =>
{
    var invoice = await db.Invoices.Include(i => i.Lines).Include(i => i.Payments).FirstOrDefaultAsync(i => i.Id == id);
    if (invoice is null) return Results.NotFound();
    invoice.Number = input.Number;
    invoice.SupplierId = input.SupplierId;
    invoice.IssueDateUtc = input.IssueDateUtc.ToUniversalTime();
    invoice.ReceivedAtUtc = input.ReceivedAtUtc.ToUniversalTime();
    invoice.DueDateUtc = input.DueDateUtc?.ToUniversalTime();
    invoice.Status = input.Status;
    invoice.QuoteId = input.QuoteId;
    invoice.Notes = input.Notes;
    db.InvoiceLines.RemoveRange(invoice.Lines);
    invoice.Lines = input.Lines.Select(l => new InvoiceLine { Concept = l.Concept, Quantity = l.Quantity, UnitPrice = l.UnitPrice, TaxRate = l.TaxRate }).ToList();
    foreach (var line in invoice.Lines) line.Recalculate();
    invoice.Recalculate();
    await db.SaveChangesAsync();
    await Activity.Record(db, invoice.ProjectId, "Invoice", invoice.Id, "Factura actualizada", invoice.Number, user.UserId());
    await AlertService.RefreshAsync(db);
    return Results.Ok(ApiDtos.Invoice(invoice));
}).RequireAuthorization();
api.MapDelete("/invoices/{id:int}", async (int id, AppDbContext db, ClaimsPrincipal user) =>
{
    var invoice = await db.Invoices.Include(i => i.Lines).Include(i => i.Payments).FirstOrDefaultAsync(i => i.Id == id);
    if (invoice is null) return Results.NotFound();
    if (invoice.Payments.Count > 0 || await DomainRules.HasEntityLinks(db, "Invoice", id)) return Results.Conflict(new { error = "La factura tiene pagos o relaciones. Anúlala o elimina primero esos vínculos." });
    db.InvoiceLines.RemoveRange(invoice.Lines);
    db.Invoices.Remove(invoice);
    await Activity.Record(db, invoice.ProjectId, "Invoice", invoice.Id, "Factura eliminada", invoice.Number, user.UserId());
    await db.SaveChangesAsync();
    await AlertService.RefreshAsync(db);
    return Results.NoContent();
}).RequireAuthorization();
api.MapPost("/payments", async (PaymentInput input, AppDbContext db, ClaimsPrincipal user) =>
{
    var invoice = await db.Invoices.FindAsync(input.InvoiceId);
    if (invoice is null) return Results.BadRequest(new { error = "Factura no existe" });
    var payment = input.ToPayment(invoice.ProjectId);
    db.Payments.Add(payment);
    await db.SaveChangesAsync();
    await Activity.Record(db, invoice.ProjectId, "Payment", payment.Id, "Pago registrado", payment.Reference ?? payment.Amount.ToString(CultureInfo.InvariantCulture), user.UserId());
    return Results.Created($"/api/payments/{payment.Id}", ApiDtos.Payment(payment));
}).RequireAuthorization();
api.MapPut("/payments/{id:int}", async (int id, PaymentInput input, AppDbContext db, ClaimsPrincipal user) =>
{
    var payment = await db.Payments.FindAsync(id);
    if (payment is null) return Results.NotFound();
    var invoice = await db.Invoices.FindAsync(input.InvoiceId);
    if (invoice is null) return Results.BadRequest(new { error = "Factura no existe" });
    payment.ProjectId = invoice.ProjectId;
    payment.InvoiceId = input.InvoiceId;
    payment.PaidAtUtc = input.PaidAtUtc.ToUniversalTime();
    payment.Amount = input.Amount;
    payment.Method = input.Method;
    payment.Reference = input.Reference;
    payment.Notes = input.Notes;
    await db.SaveChangesAsync();
    await Activity.Record(db, payment.ProjectId, "Payment", payment.Id, "Pago actualizado", payment.ActivityTitle, user.UserId());
    await AlertService.RefreshAsync(db);
    return Results.Ok(ApiDtos.Payment(payment));
}).RequireAuthorization();
api.MapDelete("/payments/{id:int}", async (int id, AppDbContext db, ClaimsPrincipal user) =>
{
    var payment = await db.Payments.FindAsync(id);
    if (payment is null) return Results.NotFound();
    if (await DomainRules.HasEntityLinks(db, "Payment", id)) return Results.Conflict(new { error = "El pago tiene relaciones explícitas." });
    db.Payments.Remove(payment);
    await Activity.Record(db, payment.ProjectId, "Payment", payment.Id, "Pago eliminado", payment.ActivityTitle, user.UserId());
    await db.SaveChangesAsync();
    await AlertService.RefreshAsync(db);
    return Results.NoContent();
}).RequireAuthorization();

api.MapPost("/documents", async (HttpRequest request, AppDbContext db, IDocumentStorage storage, ClaimsPrincipal user) =>
{
    if (!request.HasFormContentType) return Results.BadRequest(new { error = "multipart/form-data requerido" });
    var form = await request.ReadFormAsync();
    var file = form.Files["file"];
    if (file is null || file.Length == 0) return Results.BadRequest(new { error = "Archivo requerido" });
    var projectId = int.Parse(form["projectId"]!);
    var type = Enum.Parse<DocumentType>(form["type"].FirstOrDefault() ?? nameof(DocumentType.Other), true);
    var stored = await storage.SaveAsync(file);
    var document = new Document
    {
        ProjectId = projectId,
        Title = form["title"].FirstOrDefault() ?? file.FileName,
        Description = form["description"].FirstOrDefault(),
        Type = type,
        OriginalFileName = file.FileName,
        StoredFileName = stored.StoredFileName,
        MimeType = stored.MimeType,
        SizeBytes = stored.SizeBytes,
        Sha256 = stored.Sha256,
        UploadedAtUtc = DateTimeOffset.UtcNow,
        UploadedByUserId = user.UserId()
    };
    db.Documents.Add(document);
    await db.SaveChangesAsync();
    await Activity.Record(db, projectId, "Document", document.Id, "Documento subido", document.Title, user.UserId());
    return Results.Created($"/api/documents/{document.Id}", document);
}).DisableAntiforgery().RequireAuthorization();
api.MapGet("/documents", async (int? projectId, AppDbContext db) =>
{
    var query = db.Documents.Where(d => d.DeletedAtUtc == null);
    if (projectId is not null) query = query.Where(d => d.ProjectId == projectId);
    return Results.Ok(await query.OrderByDescending(d => d.UploadedAtUtc).ToListAsync());
}).RequireAuthorization();
api.MapPut("/documents/{id:int}", async (int id, DocumentInput input, AppDbContext db, ClaimsPrincipal user) =>
{
    var doc = await db.Documents.FindAsync(id);
    if (doc is null || doc.DeletedAtUtc is not null) return Results.NotFound();
    doc.Title = input.Title;
    doc.Description = input.Description;
    doc.Type = input.Type;
    await db.SaveChangesAsync();
    await Activity.Record(db, doc.ProjectId, "Document", doc.Id, "Documento actualizado", doc.Title, user.UserId());
    return Results.Ok(doc);
}).RequireAuthorization();
api.MapDelete("/documents/{id:int}", async (int id, AppDbContext db, ClaimsPrincipal user) =>
{
    var doc = await db.Documents.FindAsync(id);
    if (doc is null || doc.DeletedAtUtc is not null) return Results.NotFound();
    if (await DomainRules.HasEntityLinks(db, "Document", id)) return Results.Conflict(new { error = "El documento tiene relaciones explícitas. Elimina esas relaciones antes." });
    doc.DeletedAtUtc = DateTimeOffset.UtcNow;
    doc.DeletedByUserId = user.UserId();
    await db.SaveChangesAsync();
    await Activity.Record(db, doc.ProjectId, "Document", doc.Id, "Documento archivado", doc.Title, user.UserId());
    return Results.NoContent();
}).RequireAuthorization();
api.MapGet("/documents/{id:int}/download", async (int id, AppDbContext db, IDocumentStorage storage) =>
{
    var doc = await db.Documents.FindAsync(id);
    if (doc is null || doc.DeletedAtUtc is not null) return Results.NotFound();
    var stream = await storage.OpenReadAsync(doc.StoredFileName);
    return Results.File(stream, doc.MimeType, doc.OriginalFileName);
}).RequireAuthorization();

api.MapGet("/timeline", async (int projectId, string? entityType, int? entityId, AppDbContext db) =>
{
    var events = db.ActivityEvents.Where(a => a.ProjectId == projectId);
    if (!string.IsNullOrWhiteSpace(entityType)) events = events.Where(a => a.EntityType == entityType && a.EntityId == entityId);
    return Results.Ok(await events.OrderByDescending(a => a.OccurredAtUtc).Take(200).ToListAsync());
}).RequireAuthorization();
api.MapGet("/entity-context", async (int projectId, string entityType, int entityId, AppDbContext db) =>
{
    return Results.Ok(await EntityContext.BuildAsync(db, projectId, entityType, entityId));
}).RequireAuthorization();
api.MapGet("/notes", async (int projectId, string? entityType, int? entityId, AppDbContext db) =>
{
    var query = db.Notes.Include(n => n.References).Where(n => n.ProjectId == projectId && !n.IsDeleted);
    if (!string.IsNullOrWhiteSpace(entityType) && entityId is not null)
        query = query.Where(n =>
            (entityType == "WorkItem" && n.PrimaryWorkItemId == entityId) ||
            (entityType == "Contact" && n.PrimaryContactId == entityId) ||
            n.References.Any(r => r.TargetEntityType == entityType && r.TargetEntityId == entityId));
    return Results.Ok(await query.OrderByDescending(n => n.IsPinned).ThenByDescending(n => n.OccurredAt).Take(100).ToListAsync());
}).RequireAuthorization();
api.MapPost("/notes", async (NoteInput input, AppDbContext db, ClaimsPrincipal user) =>
{
    var note = input.ToNote(user.UserId());
    db.Notes.Add(note);
    await db.SaveChangesAsync();
    await Activity.Record(db, note.ProjectId, "Note", note.Id, "Nota añadida", note.Body, user.UserId());
    return Results.Created($"/api/notes/{note.Id}", note);
}).RequireAuthorization();
api.MapPut("/notes/{id:int}", async (int id, NoteInput input, AppDbContext db, ClaimsPrincipal user) =>
{
    var note = await db.Notes.Include(n => n.References).FirstOrDefaultAsync(n => n.Id == id && !n.IsDeleted);
    if (note is null) return Results.NotFound();
    note.Body = input.Body;
    note.OccurredAt = input.OccurredAt.ToUniversalTime();
    note.UpdatedAt = DateTimeOffset.UtcNow;
    note.PrimaryWorkItemId = input.PrimaryWorkItemId;
    note.PrimaryContactId = input.PrimaryContactId;
    note.IsPinned = input.IsPinned;
    db.NoteReferences.RemoveRange(note.References);
    note.References = input.References.Select(r => new NoteReference { TargetEntityType = r.TargetEntityType, TargetEntityId = r.TargetEntityId }).ToList();
    await db.SaveChangesAsync();
    await Activity.Record(db, note.ProjectId, "Note", note.Id, "Nota actualizada", note.Body, user.UserId());
    return Results.Ok(note);
}).RequireAuthorization();
api.MapDelete("/notes/{id:int}", async (int id, AppDbContext db, ClaimsPrincipal user) =>
{
    var note = await db.Notes.FindAsync(id);
    if (note is null || note.IsDeleted) return Results.NotFound();
    note.IsDeleted = true;
    note.DeletedAt = DateTimeOffset.UtcNow;
    note.UpdatedAt = DateTimeOffset.UtcNow;
    await db.SaveChangesAsync();
    await Activity.Record(db, note.ProjectId, "Note", note.Id, "Nota eliminada", note.Body, user.UserId());
    return Results.NoContent();
}).RequireAuthorization();
api.MapPost("/notes/{id:int}/promote", async (int id, NotePromotionInput input, AppDbContext db, ClaimsPrincipal user) =>
{
    var note = await db.Notes.Include(n => n.References).FirstOrDefaultAsync(n => n.Id == id && !n.IsDeleted);
    if (note is null) return Results.NotFound();
    var title = string.IsNullOrWhiteSpace(input.Title) ? TextTools.TitleFrom(note.Body) : input.Title.Trim();
    object created;
    string entityType;
    switch (input.TargetType)
    {
        case "Task":
            var task = new TaskItem { ProjectId = note.ProjectId, Title = title, Description = note.Body, Status = TaskStatus.Pending, Priority = Priority.Normal, ContactId = note.PrimaryContactId, PrimaryWorkItemId = note.PrimaryWorkItemId };
            db.Tasks.Add(task);
            created = task;
            entityType = "Task";
            break;
        case "Issue":
            var issue = new Issue { ProjectId = note.ProjectId, Title = title, Description = note.Body, Severity = Severity.Medium, Status = IssueStatus.Open, DetectedAtUtc = note.OccurredAt, DetectedByContactId = note.PrimaryContactId, PrimaryWorkItemId = note.PrimaryWorkItemId };
            db.Issues.Add(issue);
            created = issue;
            entityType = "Issue";
            break;
        case "Requirement":
            var requirement = new Requirement { ProjectId = note.ProjectId, Text = note.Body, Type = RequirementType.Mandatory, ComplianceStatus = ComplianceStatus.Pending, CommunicatedToContactId = note.PrimaryContactId };
            db.Requirements.Add(requirement);
            created = requirement;
            entityType = "Requirement";
            break;
        case "Decision":
            var decision = new Decision { ProjectId = note.ProjectId, Title = title, DecisionText = note.Body, DecidedAtUtc = note.OccurredAt, RegisteredByUserId = user.UserId() };
            db.Decisions.Add(decision);
            created = decision;
            entityType = "Decision";
            break;
        case "Appointment":
            var appointment = new Appointment { ProjectId = note.ProjectId, Title = title, Description = note.Body, StartUtc = note.OccurredAt, Status = AppointmentStatus.Proposed, PrimaryWorkItemId = note.PrimaryWorkItemId, ContactId = note.PrimaryContactId };
            db.Appointments.Add(appointment);
            created = appointment;
            entityType = "Appointment";
            break;
        case "BudgetRequest":
            if (note.PrimaryContactId is null) return Results.BadRequest(new { error = "Para crear una solicitud de presupuesto desde nota hace falta un contacto principal." });
            var request = new BudgetRequest { ProjectId = note.ProjectId, Title = title, WorkDescription = note.Body, ProviderId = note.PrimaryContactId.Value, RequestedAtUtc = DateTimeOffset.UtcNow, Channel = CommunicationChannel.Other, Status = BudgetRequestStatus.Draft, PrimaryWorkItemId = note.PrimaryWorkItemId, SourceNoteId = note.Id };
            db.BudgetRequests.Add(request);
            created = request;
            entityType = "BudgetRequest";
            break;
        default:
            return Results.BadRequest(new { error = "Tipo de promoción no soportado." });
    }
    await db.SaveChangesAsync();
    var entity = (EntityBase)created;
    db.NoteReferences.Add(new NoteReference { NoteId = note.Id, TargetEntityType = entityType, TargetEntityId = entity.Id });
    await Activity.Record(db, note.ProjectId, entityType, entity.Id, $"Creado desde nota #{note.Id}", title, user.UserId());
    await db.SaveChangesAsync();
    return Results.Ok(new { entityType, entityId = entity.Id });
}).RequireAuthorization();
api.MapGet("/relation-migration/preview", async (int projectId, AppDbContext db) =>
{
    return Results.Ok(await RelationMigration.BuildPreviewAsync(db, projectId));
}).RequireAuthorization();
api.MapPost("/relation-migration/run", async (int projectId, AppDbContext db, ClaimsPrincipal user) =>
{
    return Results.Ok(await RelationMigration.RunAsync(db, projectId, user.UserId()));
}).RequireAuthorization();
api.MapGet("/entity-links", async (int projectId, string? entityType, int? entityId, AppDbContext db) =>
{
    var links = db.EntityLinks.Where(l => l.ProjectId == projectId);
    if (!string.IsNullOrWhiteSpace(entityType) && entityId is not null)
        links = links.Where(l => (l.SourceType == entityType && l.SourceId == entityId) || (l.TargetType == entityType && l.TargetId == entityId));
    return Results.Ok(await links.OrderByDescending(l => l.CreatedAtUtc).ToListAsync());
}).RequireAuthorization();
api.MapPost("/entity-links", async (EntityLinkInput input, AppDbContext db, ClaimsPrincipal user) =>
{
    if (input.SourceType == input.TargetType && input.SourceId == input.TargetId) return Results.BadRequest(new { error = "No se puede enlazar una entidad consigo misma" });
    var link = input.ToEntityLink();
    db.EntityLinks.Add(link);
    await db.SaveChangesAsync();
    await Activity.Record(db, link.ProjectId, "EntityLink", link.Id, "Relación creada", $"{link.SourceType} #{link.SourceId} -> {link.TargetType} #{link.TargetId}", user.UserId());
    return Results.Created($"/api/entity-links/{link.Id}", link);
}).RequireAuthorization();
api.MapDelete("/entity-links/{id:int}", async (int id, AppDbContext db, ClaimsPrincipal user) =>
{
    var link = await db.EntityLinks.FindAsync(id);
    if (link is null) return Results.NotFound();
    db.EntityLinks.Remove(link);
    await db.SaveChangesAsync();
    await Activity.Record(db, link.ProjectId, "EntityLink", id, "Relación retirada", $"{link.SourceType} #{link.SourceId} -> {link.TargetType} #{link.TargetId}", user.UserId());
    return Results.NoContent();
}).RequireAuthorization();
api.MapGet("/alerts", async (int? projectId, AppDbContext db) =>
{
    await AlertService.RefreshAsync(db);
    var query = db.Alerts.AsQueryable();
    if (projectId is not null) query = query.Where(a => a.ProjectId == projectId);
    return Results.Ok(await query.Where(a => !a.Resolved).OrderByDescending(a => a.Severity).ThenBy(a => a.DueUtc).ToListAsync());
}).RequireAuthorization();
api.MapGet("/search", async (string q, AppDbContext db) =>
{
    if (SearchIndex.Terms(q).Length == 0) return Results.Ok(Array.Empty<object>());
    var contacts = (await db.Contacts.ToListAsync())
        .Where(c => SearchIndex.Matches(q, c.Name, c.Surname, c.CompanyName, c.DisplayName, c.Phone, c.Email, c.Notes, SearchIndex.Trade(c.Trade), c.Status))
        .Take(10)
        .ToList();
    var work = (await db.WorkItems.ToListAsync())
        .Where(w => SearchIndex.Matches(q, w.Title, w.Description, SearchIndex.Trade(w.Category), w.Status, w.Priority))
        .Take(10)
        .ToList();
    var docs = (await db.Documents.Where(d => d.DeletedAtUtc == null).ToListAsync())
        .Where(d => SearchIndex.Matches(q, d.Title, d.Description, d.OriginalFileName, d.MimeType, d.Type))
        .Take(10)
        .ToList();
    var quotes = (await db.Quotes.Include(x => x.Provider).Include(x => x.Lines).ToListAsync())
        .Where(x => SearchIndex.Matches(q, x.Reference, x.Notes, x.Provider?.DisplayName, x.Provider?.Name, x.Provider?.CompanyName, x.Status, x.Total, string.Join(' ', x.Lines.Select(l => $"{l.Concept} {l.Description} {SearchIndex.Trade(l.Category)}"))))
        .Take(10)
        .ToList();
    var invoices = (await db.Invoices.Include(x => x.Supplier).Include(x => x.Lines).ToListAsync())
        .Where(x => SearchIndex.Matches(q, x.Number, x.Notes, x.Supplier?.DisplayName, x.Supplier?.Name, x.Supplier?.CompanyName, x.Status, x.Total, string.Join(' ', x.Lines.Select(l => l.Concept))))
        .Take(10)
        .ToList();
    return Results.Ok(new { contacts, workItems = work, documents = docs, quotes, invoices });
}).RequireAuthorization();

app.Run();

public partial class Program { }

public static class EndpointExtensions
{
    public static RouteGroupBuilder MapCrud<TEntity, TInput>(this RouteGroupBuilder group, Func<TInput, TEntity> map, string entityType)
        where TEntity : EntityBase, IProjectEntity
    {
        group.MapGet("/", async (int? projectId, AppDbContext db) =>
        {
            var set = db.Set<TEntity>().AsQueryable();
            if (projectId is not null) set = set.Where(x => x.ProjectId == projectId);
            return Results.Ok(await set.OrderByDescending(x => x.Id).ToListAsync());
        }).RequireAuthorization();
        group.MapPost("/", async (TInput input, AppDbContext db, ClaimsPrincipal user) =>
        {
            var entity = map(input);
            db.Set<TEntity>().Add(entity);
            await db.SaveChangesAsync();
            await Activity.Record(db, entity.ProjectId, entityType, entity.Id, $"{entityType} creado", entity.ActivityTitle, user.UserId());
            return Results.Created($"/api/{entityType.ToLowerInvariant()}s/{entity.Id}", entity);
        }).RequireAuthorization();
        group.MapPut("/{id:int}", async (int id, TInput input, AppDbContext db, ClaimsPrincipal user) =>
        {
            var entity = await db.Set<TEntity>().FindAsync(id);
            if (entity is null) return Results.NotFound();
            var updated = map(input);
            updated.Id = id;
            db.Entry(entity).CurrentValues.SetValues(updated);
            await db.SaveChangesAsync();
            await Activity.Record(db, entity.ProjectId, entityType, entity.Id, $"{entityType} actualizado", entity.ActivityTitle, user.UserId());
            return Results.Ok(entity);
        }).RequireAuthorization();
        group.MapDelete("/{id:int}", async (int id, AppDbContext db, ClaimsPrincipal user) =>
        {
            var entity = await db.Set<TEntity>().FindAsync(id);
            if (entity is null) return Results.NotFound();
            if (await DomainRules.HasEntityLinks(db, entityType, id)) return Results.Conflict(new { error = "La entidad tiene relaciones explícitas. Elimina esas relaciones antes." });
            db.Set<TEntity>().Remove(entity);
            await Activity.Record(db, entity.ProjectId, entityType, entity.Id, $"{entityType} eliminado", entity.ActivityTitle, user.UserId());
            try
            {
                await db.SaveChangesAsync();
            }
            catch (DbUpdateException)
            {
                return Results.Conflict(new { error = "No se puede eliminar porque existen datos relacionados." });
            }
            return Results.NoContent();
        }).RequireAuthorization();
        return group;
    }
}

public class AppDbContext(DbContextOptions<AppDbContext> options) : DbContext(options)
{
    public DbSet<UserAccount> Users => Set<UserAccount>();
    public DbSet<Project> Projects => Set<Project>();
    public DbSet<WorkItem> WorkItems => Set<WorkItem>();
    public DbSet<WorkItemDependency> WorkItemDependencies => Set<WorkItemDependency>();
    public DbSet<Contact> Contacts => Set<Contact>();
    public DbSet<WorkItemContact> WorkItemContacts => Set<WorkItemContact>();
    public DbSet<Communication> Communications => Set<Communication>();
    public DbSet<WorkItemCommunication> WorkItemCommunications => Set<WorkItemCommunication>();
    public DbSet<TaskItem> Tasks => Set<TaskItem>();
    public DbSet<TaskCategory> TaskCategories => Set<TaskCategory>();
    public DbSet<TaskDependency> TaskDependencies => Set<TaskDependency>();
    public DbSet<Appointment> Appointments => Set<Appointment>();
    public DbSet<Intervention> Interventions => Set<Intervention>();
    public DbSet<Issue> Issues => Set<Issue>();
    public DbSet<Requirement> Requirements => Set<Requirement>();
    public DbSet<Decision> Decisions => Set<Decision>();
    public DbSet<BudgetRequest> BudgetRequests => Set<BudgetRequest>();
    public DbSet<Quote> Quotes => Set<Quote>();
    public DbSet<QuoteLine> QuoteLines => Set<QuoteLine>();
    public DbSet<QuoteComparison> QuoteComparisons => Set<QuoteComparison>();
    public DbSet<QuoteComparisonEntry> QuoteComparisonEntries => Set<QuoteComparisonEntry>();
    public DbSet<ComparisonConcept> ComparisonConcepts => Set<ComparisonConcept>();
    public DbSet<Invoice> Invoices => Set<Invoice>();
    public DbSet<InvoiceLine> InvoiceLines => Set<InvoiceLine>();
    public DbSet<Payment> Payments => Set<Payment>();
    public DbSet<Document> Documents => Set<Document>();
    public DbSet<ActivityEvent> ActivityEvents => Set<ActivityEvent>();
    public DbSet<AuditLog> AuditLogs => Set<AuditLog>();
    public DbSet<Alert> Alerts => Set<Alert>();
    public DbSet<EntityLink> EntityLinks => Set<EntityLink>();
    public DbSet<Note> Notes => Set<Note>();
    public DbSet<NoteReference> NoteReferences => Set<NoteReference>();
    public DbSet<RelationMigrationReview> RelationMigrationReviews => Set<RelationMigrationReview>();

    protected override void OnModelCreating(ModelBuilder b)
    {
        b.Entity<UserAccount>().HasIndex(u => u.Email).IsUnique();
        b.Entity<WorkItemDependency>().HasKey(x => new { x.WorkItemId, x.DependsOnWorkItemId });
        b.Entity<WorkItemDependency>().HasOne(x => x.WorkItem).WithMany(x => x.DependsOn).HasForeignKey(x => x.WorkItemId).OnDelete(DeleteBehavior.Restrict);
        b.Entity<WorkItemDependency>().HasOne(x => x.DependsOnWorkItem).WithMany(x => x.Dependents).HasForeignKey(x => x.DependsOnWorkItemId).OnDelete(DeleteBehavior.Restrict);
        b.Entity<WorkItemContact>().HasKey(x => new { x.WorkItemId, x.ContactId });
        b.Entity<WorkItemCommunication>().HasKey(x => new { x.WorkItemId, x.CommunicationId });
        b.Entity<Note>().HasMany(x => x.References).WithOne().HasForeignKey(x => x.NoteId).OnDelete(DeleteBehavior.Cascade);
        b.Entity<NoteReference>().HasIndex(x => new { x.TargetEntityType, x.TargetEntityId });
        b.Entity<RelationMigrationReview>().HasIndex(x => x.EntityLinkId).IsUnique();
        b.Entity<TaskItem>().HasOne(x => x.Category).WithMany().HasForeignKey(x => x.CategoryId).OnDelete(DeleteBehavior.SetNull);
        b.Entity<TaskDependency>().HasIndex(x => new { x.PredecessorTaskId, x.SuccessorTaskId }).IsUnique();
        foreach (var entity in b.Model.GetEntityTypes())
        {
            foreach (var property in entity.GetProperties().Where(p => p.ClrType == typeof(decimal) || p.ClrType == typeof(decimal?)))
                property.SetPrecision(18);
        }
    }
}

public interface IProjectEntity { int ProjectId { get; set; } }
public abstract class EntityBase { public int Id { get; set; } public virtual string ActivityTitle => ToString() ?? GetType().Name; }

public class UserAccount : EntityBase { [MaxLength(320)] public string Email { get; set; } = ""; public string PasswordHash { get; set; } = ""; [MaxLength(160)] public string DisplayName { get; set; } = ""; public DateTimeOffset CreatedAtUtc { get; set; } = DateTimeOffset.UtcNow; }
public class Project : EntityBase, IProjectEntity
{
    public int ProjectId { get => Id; set { } }
    [MaxLength(180)] public string Name { get; set; } = "";
    public string? Description { get; set; }
    public string? Location { get; set; }
    public ProjectStatus Status { get; set; }
    public DateTimeOffset? PlannedStartUtc { get; set; }
    public DateTimeOffset? ActualStartUtc { get; set; }
    public DateTimeOffset? PlannedEndUtc { get; set; }
    public DateTimeOffset? ActualEndUtc { get; set; }
    public decimal TargetBudget { get; set; }
    public decimal ContingencyFund { get; set; }
    public string? Notes { get; set; }
    public string[] Tags { get; set; } = [];
    public DateTimeOffset CreatedAtUtc { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset UpdatedAtUtc { get; set; } = DateTimeOffset.UtcNow;
    public override string ActivityTitle => Name;
}
public class WorkItem : EntityBase, IProjectEntity
{
    public int ProjectId { get; set; }
    public Project? Project { get; set; }
    public string Title { get; set; } = "";
    public string? Description { get; set; }
    public TradeCategory Category { get; set; }
    public WorkItemStatus Status { get; set; }
    public Priority Priority { get; set; }
    public decimal TargetCost { get; set; }
    public decimal EstimatedCost { get; set; }
    public decimal CommittedCost { get; set; }
    public decimal InvoicedCost { get; set; }
    public decimal PaidCost { get; set; }
    public DateTimeOffset? PlannedStartUtc { get; set; }
    public DateTimeOffset? ActualStartUtc { get; set; }
    public DateTimeOffset? PlannedEndUtc { get; set; }
    public DateTimeOffset? ActualEndUtc { get; set; }
    public List<WorkItemDependency> DependsOn { get; set; } = [];
    public List<WorkItemDependency> Dependents { get; set; } = [];
    public override string ActivityTitle => Title;
}
public class WorkItemDependency { public int WorkItemId { get; set; } public WorkItem? WorkItem { get; set; } public int DependsOnWorkItemId { get; set; } public WorkItem? DependsOnWorkItem { get; set; } }
public class Contact : EntityBase, IProjectEntity
{
    public int ProjectId { get; set; }
    public string Name { get; set; } = "";
    public string? Surname { get; set; }
    public string? CompanyName { get; set; }
    public ContactType Type { get; set; }
    public TradeCategory Trade { get; set; }
    public string? Phone { get; set; }
    public string? Email { get; set; }
    public string? Address { get; set; }
    public string? TaxId { get; set; }
    public string? ContactPerson { get; set; }
    public string? Website { get; set; }
    public ContactStatus Status { get; set; }
    public int? InternalRating { get; set; }
    public string? Notes { get; set; }
    public string[] Tags { get; set; } = [];
    public DateTimeOffset? FirstContactUtc { get; set; }
    public DateTimeOffset? LastContactUtc { get; set; }
    public string DisplayName => string.IsNullOrWhiteSpace(CompanyName) ? $"{Name} {Surname}".Trim() : $"{Name} · {CompanyName}";
    public override string ActivityTitle => DisplayName;
}
public class WorkItemContact { public int WorkItemId { get; set; } public int ContactId { get; set; } }
public class Communication : EntityBase, IProjectEntity
{
    public int ProjectId { get; set; }
    public DateTimeOffset OccurredAtUtc { get; set; }
    public int? ContactId { get; set; }
    public Contact? Contact { get; set; }
    public CommunicationType Type { get; set; }
    public string Summary { get; set; } = "";
    public string? Detail { get; set; }
    public string? Result { get; set; }
    public string? NextStep { get; set; }
    public int RegisteredByUserId { get; set; }
    public int? PrimaryWorkItemId { get; set; }
    public override string ActivityTitle => Summary;
}
public class WorkItemCommunication { public int WorkItemId { get; set; } public int CommunicationId { get; set; } }
public class TaskItem : EntityBase, IProjectEntity
{
    public int ProjectId { get; set; }
    public string Title { get; set; } = "";
    public string? Description { get; set; }
    public TaskStatus Status { get; set; }
    public Priority Priority { get; set; }
    public string? Responsible { get; set; }
    public DateTimeOffset CreatedAtUtc { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset? PlannedStartUtc { get; set; }
    public DateTimeOffset? DueUtc { get; set; }
    public DateTimeOffset? CompletedAtUtc { get; set; }
    public DateTimeOffset? ReminderUtc { get; set; }
    public int? ContactId { get; set; }
    public Contact? Contact { get; set; }
    public int? PrimaryWorkItemId { get; set; }
    public int? IssueId { get; set; }
    public TaskType TaskType { get; set; } = TaskType.Task;
    public TaskTimingKind TimingKind { get; set; } = TaskTimingKind.Work;
    public int? ParentTaskId { get; set; }
    public int SortOrder { get; set; }
    public int ProgressPercent { get; set; }
    public bool IsPlanningProvisional { get; set; }
    public string? PlanningWarning { get; set; }
    public DateTimeOffset? PlannedStartAt { get; set; }
    public DateTimeOffset? PlannedEndAt { get; set; }
    public DateTimeOffset? ActualStartAt { get; set; }
    public DateTimeOffset? ActualEndAt { get; set; }
    public int? CategoryId { get; set; }
    public TaskCategory? Category { get; set; }
    public string? BlockingReason { get; set; }
    public override string ActivityTitle => Title;
}
public class TaskCategory : EntityBase, IProjectEntity { public int ProjectId { get; set; } public string Name { get; set; } = ""; public string? Color { get; set; } public int SortOrder { get; set; } public override string ActivityTitle => Name; }
public class TaskDependency : EntityBase, IProjectEntity { public int ProjectId { get; set; } public int PredecessorTaskId { get; set; } public int SuccessorTaskId { get; set; } public TaskDependencyType DependencyType { get; set; } = TaskDependencyType.FinishToStart; }
public class Appointment : EntityBase, IProjectEntity { public int ProjectId { get; set; } public string Title { get; set; } = ""; public DateTimeOffset StartUtc { get; set; } public DateTimeOffset? EndUtc { get; set; } public string? Location { get; set; } public string? Participants { get; set; } public string? Description { get; set; } public AppointmentStatus Status { get; set; } public DateTimeOffset? ReminderUtc { get; set; } public int? InterventionId { get; set; } public int? PrimaryWorkItemId { get; set; } public int? ContactId { get; set; } public override string ActivityTitle => Title; }
public class Intervention : EntityBase, IProjectEntity { public int ProjectId { get; set; } public string Title { get; set; } = ""; public string? Description { get; set; } public int? ProviderId { get; set; } public Contact? Provider { get; set; } public InterventionStatus Status { get; set; } public DateTimeOffset? PlannedStartUtc { get; set; } public DateTimeOffset? ActualStartUtc { get; set; } public DateTimeOffset? ActualEndUtc { get; set; } public decimal? ExpectedCost { get; set; } public decimal? AgreedCost { get; set; } public decimal? FinalCost { get; set; } public int? OriginQuoteId { get; set; } public int? PrimaryWorkItemId { get; set; } public int? AppointmentId { get; set; } public string? Result { get; set; } public string? Warranty { get; set; } public string? FollowUpNotes { get; set; } public override string ActivityTitle => Title; }
public class Issue : EntityBase, IProjectEntity { public int ProjectId { get; set; } public string Title { get; set; } = ""; public string? Description { get; set; } public Severity Severity { get; set; } public IssueStatus Status { get; set; } public DateTimeOffset DetectedAtUtc { get; set; } public int? DetectedByContactId { get; set; } public int? PrimaryWorkItemId { get; set; } public string? KnownCause { get; set; } public string? ProposedSolution { get; set; } public string? AppliedSolution { get; set; } public override string ActivityTitle => Title; }
public class Requirement : EntityBase, IProjectEntity { public int ProjectId { get; set; } public string Text { get; set; } = ""; public RequirementType Type { get; set; } public string? Justification { get; set; } public int? CommunicatedToContactId { get; set; } public DateTimeOffset? CommunicatedAtUtc { get; set; } public ComplianceStatus ComplianceStatus { get; set; } public override string ActivityTitle => Text; }
public class Decision : EntityBase, IProjectEntity { public int ProjectId { get; set; } public string Title { get; set; } = ""; public string DecisionText { get; set; } = ""; public DateTimeOffset DecidedAtUtc { get; set; } public string? Reason { get; set; } public string? Alternatives { get; set; } public decimal? EconomicImpact { get; set; } public int RegisteredByUserId { get; set; } public override string ActivityTitle => Title; }
public class BudgetRequest : EntityBase, IProjectEntity { public int ProjectId { get; set; } public string Title { get; set; } = ""; public string WorkDescription { get; set; } = ""; public int ProviderId { get; set; } public Contact? Provider { get; set; } public DateTimeOffset RequestedAtUtc { get; set; } public CommunicationChannel Channel { get; set; } public DateTimeOffset? ExpectedDeadlineUtc { get; set; } public BudgetRequestStatus Status { get; set; } public bool RequiresVisit { get; set; } public int? PrimaryWorkItemId { get; set; } public int? SourceCommunicationId { get; set; } public int? SourceNoteId { get; set; } public int? SourceTaskId { get; set; } public override string ActivityTitle => Title; }
public class Quote : EntityBase, IProjectEntity { public int ProjectId { get; set; } public string Reference { get; set; } = ""; public int ProviderId { get; set; } public Contact? Provider { get; set; } public DateTimeOffset IssuedAtUtc { get; set; } public DateTimeOffset ReceivedAtUtc { get; set; } public DateTimeOffset? ValidUntilUtc { get; set; } public QuoteStatus Status { get; set; } public decimal Subtotal { get; set; } public decimal Discounts { get; set; } public decimal Taxes { get; set; } public decimal Total { get; set; } public string Currency { get; set; } = "EUR"; public string? EstimatedDuration { get; set; } public string? PaymentTerms { get; set; } public string? Warranty { get; set; } public string? Exclusions { get; set; } public string? Notes { get; set; } public int? BudgetRequestId { get; set; } public int? PrimaryWorkItemId { get; set; } public int? PreviousQuoteId { get; set; } public List<QuoteLine> Lines { get; set; } = []; public void Recalculate() { Subtotal = Lines.Sum(l => l.Quantity * l.UnitPrice); Taxes = Lines.Sum(l => l.TaxAmount); Total = Subtotal - Discounts + Taxes; } public override string ActivityTitle => Reference; }
public class QuoteLine : EntityBase { public int QuoteId { get; set; } public string Concept { get; set; } = ""; public string? Description { get; set; } public decimal Quantity { get; set; } public string Unit { get; set; } = "ud"; public decimal UnitPrice { get; set; } public decimal TaxRate { get; set; } public decimal TaxAmount { get; set; } public decimal Total { get; set; } public TradeCategory Category { get; set; } public int? WorkItemId { get; set; } public bool Optional { get; set; } public LineInclusionStatus InclusionStatus { get; set; } public void Recalculate() { var baseAmount = Quantity * UnitPrice; TaxAmount = Math.Round(baseAmount * TaxRate / 100m, 2); Total = baseAmount + TaxAmount; } }
public class QuoteComparison : EntityBase, IProjectEntity { public int ProjectId { get; set; } public string Title { get; set; } = ""; public string? DecisionJustification { get; set; } public int? SelectedQuoteId { get; set; } public List<QuoteComparisonEntry> Entries { get; set; } = []; public List<ComparisonConcept> Concepts { get; set; } = []; public override string ActivityTitle => Title; }
public class QuoteComparisonEntry : EntityBase { public int QuoteComparisonId { get; set; } public int QuoteId { get; set; } public Quote? Quote { get; set; } public decimal KnownAdditionalCosts { get; set; } public int InternalRating { get; set; } public string? Notes { get; set; } public OfferState State { get; set; } }
public class ComparisonConcept : EntityBase { public int QuoteComparisonId { get; set; } public string Name { get; set; } = ""; public bool Required { get; set; } public string? Notes { get; set; } }
public class Invoice : EntityBase, IProjectEntity { public int ProjectId { get; set; } public string Number { get; set; } = ""; public int SupplierId { get; set; } public Contact? Supplier { get; set; } public DateTimeOffset IssueDateUtc { get; set; } public DateTimeOffset ReceivedAtUtc { get; set; } public DateTimeOffset? DueDateUtc { get; set; } public decimal Subtotal { get; set; } public decimal Taxes { get; set; } public decimal Total { get; set; } public InvoiceStatus Status { get; set; } public int? QuoteId { get; set; } public int? PrimaryWorkItemId { get; set; } public string? Notes { get; set; } public List<InvoiceLine> Lines { get; set; } = []; public List<Payment> Payments { get; set; } = []; public void Recalculate() { Subtotal = Lines.Sum(l => l.Quantity * l.UnitPrice); Taxes = Lines.Sum(l => l.TaxAmount); Total = Subtotal + Taxes; } public override string ActivityTitle => Number; }
public class InvoiceLine : EntityBase { public int InvoiceId { get; set; } public string Concept { get; set; } = ""; public decimal Quantity { get; set; } public decimal UnitPrice { get; set; } public decimal TaxRate { get; set; } public decimal TaxAmount { get; set; } public decimal Total { get; set; } public void Recalculate() { var baseAmount = Quantity * UnitPrice; TaxAmount = Math.Round(baseAmount * TaxRate / 100m, 2); Total = baseAmount + TaxAmount; } }
public class Payment : EntityBase, IProjectEntity { public int ProjectId { get; set; } public int InvoiceId { get; set; } public Invoice? Invoice { get; set; } public DateTimeOffset PaidAtUtc { get; set; } public decimal Amount { get; set; } public PaymentMethod Method { get; set; } public string? Reference { get; set; } public string? Notes { get; set; } public override string ActivityTitle => Reference ?? Amount.ToString("0.00", CultureInfo.InvariantCulture); }
public class Document : EntityBase, IProjectEntity { public int ProjectId { get; set; } public string Title { get; set; } = ""; public string? Description { get; set; } public DocumentType Type { get; set; } public string OriginalFileName { get; set; } = ""; public string StoredFileName { get; set; } = ""; public string MimeType { get; set; } = ""; public long SizeBytes { get; set; } public string Sha256 { get; set; } = ""; public DateTimeOffset UploadedAtUtc { get; set; } public int UploadedByUserId { get; set; } public DateTimeOffset? DeletedAtUtc { get; set; } public int? DeletedByUserId { get; set; } public override string ActivityTitle => Title; }
public class ActivityEvent : EntityBase, IProjectEntity { public int ProjectId { get; set; } public DateTimeOffset OccurredAtUtc { get; set; } = DateTimeOffset.UtcNow; public string EntityType { get; set; } = ""; public int EntityId { get; set; } public string Action { get; set; } = ""; public string Summary { get; set; } = ""; public int? UserId { get; set; } public string? MetadataJson { get; set; } }
public class AuditLog : EntityBase, IProjectEntity { public int ProjectId { get; set; } public DateTimeOffset OccurredAtUtc { get; set; } = DateTimeOffset.UtcNow; public int? UserId { get; set; } public string EntityType { get; set; } = ""; public int EntityId { get; set; } public string Action { get; set; } = ""; public string? BeforeJson { get; set; } public string? AfterJson { get; set; } }
public class Alert : EntityBase, IProjectEntity { public int ProjectId { get; set; } public string Title { get; set; } = ""; public string? Description { get; set; } public AlertType Type { get; set; } public Severity Severity { get; set; } public DateTimeOffset? DueUtc { get; set; } public string EntityType { get; set; } = ""; public int EntityId { get; set; } public bool Resolved { get; set; } public override string ActivityTitle => Title; }
public class EntityLink : EntityBase, IProjectEntity { public int ProjectId { get; set; } public string SourceType { get; set; } = ""; public int SourceId { get; set; } public string TargetType { get; set; } = ""; public int TargetId { get; set; } public LinkType Type { get; set; } public string? Description { get; set; } public DateTimeOffset CreatedAtUtc { get; set; } = DateTimeOffset.UtcNow; }
public class Note : EntityBase, IProjectEntity { public int ProjectId { get; set; } public string Body { get; set; } = ""; public DateTimeOffset OccurredAt { get; set; } = DateTimeOffset.UtcNow; public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow; public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow; public int? AuthorUserId { get; set; } public int? PrimaryWorkItemId { get; set; } public int? PrimaryContactId { get; set; } public bool IsPinned { get; set; } public bool IsDeleted { get; set; } public DateTimeOffset? DeletedAt { get; set; } public int? SourceEntityLinkId { get; set; } public List<NoteReference> References { get; set; } = []; public override string ActivityTitle => Body; }
public class NoteReference : EntityBase { public int NoteId { get; set; } public string TargetEntityType { get; set; } = ""; public int TargetEntityId { get; set; } }
public class RelationMigrationReview : EntityBase, IProjectEntity { public int ProjectId { get; set; } public int EntityLinkId { get; set; } public string SourceLabel { get; set; } = ""; public string TargetLabel { get; set; } = ""; public LinkType OldType { get; set; } public string? OldContext { get; set; } public string Proposal { get; set; } = ""; public string Status { get; set; } = "Pending"; public DateTimeOffset CreatedAtUtc { get; set; } = DateTimeOffset.UtcNow; public DateTimeOffset? AppliedAtUtc { get; set; } public int? CreatedNoteId { get; set; } }

public enum ProjectStatus { Planning, InProgress, Paused, Completed, Cancelled }
public enum TradeCategory { Electricity, Masonry, Plumbing, Carpentry, Architecture, Painting, Hvac, Windows, Kitchen, Administration, ElectricDistributor, Other }
public enum WorkItemStatus { Planned, InProgress, Blocked, Done, Cancelled }
public enum Priority { Low, Normal, High, Critical }
public enum ContactType { Person, Freelancer, Company, Administration, Utility, Distributor, Supplier, Other }
public enum ContactStatus { Candidate, Contacted, WaitingReply, Selected, Contracted, Discarded, Finished }
public enum CommunicationType { OutgoingCall, IncomingCall, SentEmail, ReceivedEmail, Message, Meeting, Visit, InPerson, FollowUpNote }
public enum TaskType { Task, Epic, Milestone }
public enum TaskTimingKind { Work, Wait, Milestone }
public enum TaskStatus { Pending, InProgress, Blocked, Completed, Cancelled }
public enum TaskDependencyType { FinishToStart, StartToStart }
public enum AppointmentStatus { Proposed, Confirmed, Done, Cancelled }
public enum InterventionStatus { Proposed, Planned, Confirmed, InProgress, Finished, Cancelled, NeedsReview }
public enum Severity { Low, Medium, High, Critical }
public enum IssueStatus { Open, Investigating, ProposedSolution, Resolved, Cancelled }
public enum RequirementType { Mandatory, Preferred, Recommended, Rejected }
public enum ComplianceStatus { Pending, Communicated, Accepted, Fulfilled, NotFulfilled, Discarded }
public enum CommunicationChannel { Phone, Email, Message, InPerson, Web, Other }
public enum BudgetRequestStatus { Draft, Requested, Received, Expired, Cancelled, NoReply }
public enum QuoteStatus { Received, Reviewing, NeedsClarification, Accepted, Rejected, Expired, Replaced }
public enum LineInclusionStatus { Included, Excluded, PendingClarification }
public enum OfferState { Candidate, Comparable, NotComparable, Selected, Rejected }
public enum InvoiceStatus { Received, Reviewed, PartiallyPaid, Paid, Overdue, Cancelled, Disputed }
public enum PaymentMethod { Transfer, Card, Cash, DirectDebit, Other }
public enum DocumentType { Plan, Quote, Invoice, PaymentProof, Contract, License, Certificate, ElectricalBulletin, Photo, Report, Communication, Other }
public enum AlertType { OverdueTask, UpcomingTask, BudgetRequestNoReply, QuoteExpiring, InvoiceOverdue, UpcomingAppointment, InterventionBlocked, DependencyUnmet, MissingDocumentation }
public enum LinkType { DependsOn, OriginatedBy, Resolves, Replaces, RelatedTo, Justifies, Blocks, Generated, Evidence, DocumentOf, OriginQuote, CorrespondingInvoice }

public record LoginRequest(string Email, string Password);
public record UserDto(int Id, string Email, string DisplayName);
public record ProjectInput(string Name, string? Description, string? Location, ProjectStatus Status, decimal TargetBudget, decimal ContingencyFund, string? Notes, string[]? Tags) { public Project ToProject() => new() { Name = Name, Description = Description, Location = Location, Status = Status, TargetBudget = TargetBudget, ContingencyFund = ContingencyFund, Notes = Notes, Tags = Tags ?? [] }; }
public record WorkItemInput(int ProjectId, string Title, string? Description, TradeCategory Category, WorkItemStatus Status, Priority Priority, decimal TargetCost, decimal EstimatedCost, int? DependsOnWorkItemId) { public WorkItem ToWorkItem() => new() { ProjectId = ProjectId, Title = Title, Description = Description, Category = Category, Status = Status, Priority = Priority, TargetCost = TargetCost, EstimatedCost = EstimatedCost }; }
public record WorkItemStatusUpdate(WorkItemStatus Status);
public record ContactInput(int ProjectId, string Name, string? Surname, string? CompanyName, ContactType Type, TradeCategory Trade, string? Phone, string? Email, ContactStatus Status, string? Notes) { public Contact ToContact() => new() { ProjectId = ProjectId, Name = Name, Surname = Surname, CompanyName = CompanyName, Type = Type, Trade = Trade, Phone = Phone, Email = Email, Status = Status, Notes = Notes, FirstContactUtc = DateTimeOffset.UtcNow, LastContactUtc = DateTimeOffset.UtcNow }; }
public record CommunicationInput(int ProjectId, DateTimeOffset OccurredAtUtc, int? ContactId, CommunicationType Type, string Summary, string? Detail, string? Result, string? NextStep, int[] WorkItemIds, bool CreateFollowUpTask, string? FollowUpTitle, DateTimeOffset? FollowUpDueUtc, int? PrimaryWorkItemId = null) { public Communication ToCommunication(int userId) => new() { ProjectId = ProjectId, OccurredAtUtc = OccurredAtUtc.ToUniversalTime(), ContactId = ContactId, Type = Type, Summary = Summary, Detail = Detail, Result = Result, NextStep = NextStep, RegisteredByUserId = userId, PrimaryWorkItemId = PrimaryWorkItemId }; }
public record TaskInput(int ProjectId, string Title, string? Description, TaskStatus Status, Priority Priority, string? Responsible, DateTimeOffset? DueUtc, int? ContactId, string? BlockingReason, int? PrimaryWorkItemId = null, int? IssueId = null, TaskType TaskType = TaskType.Task, int? ParentTaskId = null, int SortOrder = 0, int ProgressPercent = 0, DateTimeOffset? PlannedStartAt = null, DateTimeOffset? PlannedEndAt = null, DateTimeOffset? ActualStartAt = null, DateTimeOffset? ActualEndAt = null, int? CategoryId = null, TaskTimingKind TimingKind = TaskTimingKind.Work, bool IsPlanningProvisional = false, string? PlanningWarning = null) { public TaskItem ToTask() => new() { ProjectId = ProjectId, Title = Title, Description = Description, Status = Status, Priority = Priority, Responsible = Responsible, DueUtc = DueUtc?.ToUniversalTime(), ContactId = ContactId, BlockingReason = BlockingReason, PrimaryWorkItemId = PrimaryWorkItemId, IssueId = IssueId, TaskType = TaskType, ParentTaskId = ParentTaskId, SortOrder = SortOrder, ProgressPercent = ProgressPercent, PlannedStartAt = PlannedStartAt?.ToUniversalTime(), PlannedEndAt = PlannedEndAt?.ToUniversalTime(), ActualStartAt = ActualStartAt?.ToUniversalTime(), ActualEndAt = ActualEndAt?.ToUniversalTime(), CategoryId = CategoryId, TimingKind = TimingKind, IsPlanningProvisional = IsPlanningProvisional, PlanningWarning = PlanningWarning }; }
public record TaskStatusUpdate(TaskStatus Status, string? BlockingReason);
public record TaskMoveInput(int? ParentTaskId, int SortOrder);
public record TaskTypeUpdate(TaskType TaskType);
public record TaskCategoryInput(int ProjectId, string Name, string? Color, int SortOrder);
public record TaskDependencyInput(int ProjectId, int PredecessorTaskId, int SuccessorTaskId, TaskDependencyType DependencyType);
public record AppointmentInput(int ProjectId, string Title, DateTimeOffset StartUtc, DateTimeOffset? EndUtc, string? Location, string? Participants, string? Description, AppointmentStatus Status, int? PrimaryWorkItemId = null, int? ContactId = null, int? InterventionId = null) { public Appointment ToAppointment() => new() { ProjectId = ProjectId, Title = Title, StartUtc = StartUtc.ToUniversalTime(), EndUtc = EndUtc?.ToUniversalTime(), Location = Location, Participants = Participants, Description = Description, Status = Status, PrimaryWorkItemId = PrimaryWorkItemId, ContactId = ContactId, InterventionId = InterventionId }; }
public record InterventionInput(int ProjectId, string Title, string? Description, int? ProviderId, InterventionStatus Status, DateTimeOffset? PlannedStartUtc, decimal? ExpectedCost, decimal? AgreedCost, int? PrimaryWorkItemId = null, int? AppointmentId = null) { public Intervention ToIntervention() => new() { ProjectId = ProjectId, Title = Title, Description = Description, ProviderId = ProviderId, Status = Status, PlannedStartUtc = PlannedStartUtc?.ToUniversalTime(), ExpectedCost = ExpectedCost, AgreedCost = AgreedCost, PrimaryWorkItemId = PrimaryWorkItemId, AppointmentId = AppointmentId }; }
public record IssueInput(int ProjectId, string Title, string? Description, Severity Severity, IssueStatus Status, DateTimeOffset DetectedAtUtc, int? DetectedByContactId, string? KnownCause, string? ProposedSolution, string? AppliedSolution, int? PrimaryWorkItemId = null) { public Issue ToIssue() => new() { ProjectId = ProjectId, Title = Title, Description = Description, Severity = Severity, Status = Status, DetectedAtUtc = DetectedAtUtc.ToUniversalTime(), DetectedByContactId = DetectedByContactId, KnownCause = KnownCause, ProposedSolution = ProposedSolution, AppliedSolution = AppliedSolution, PrimaryWorkItemId = PrimaryWorkItemId }; }
public record RequirementInput(int ProjectId, string Text, RequirementType Type, string? Justification, int? CommunicatedToContactId, DateTimeOffset? CommunicatedAtUtc, ComplianceStatus ComplianceStatus) { public Requirement ToRequirement() => new() { ProjectId = ProjectId, Text = Text, Type = Type, Justification = Justification, CommunicatedToContactId = CommunicatedToContactId, CommunicatedAtUtc = CommunicatedAtUtc?.ToUniversalTime(), ComplianceStatus = ComplianceStatus }; }
public record DecisionInput(int ProjectId, string Title, string DecisionText, DateTimeOffset DecidedAtUtc, string? Reason, string? Alternatives, decimal? EconomicImpact) { public Decision ToDecision() => new() { ProjectId = ProjectId, Title = Title, DecisionText = DecisionText, DecidedAtUtc = DecidedAtUtc.ToUniversalTime(), Reason = Reason, Alternatives = Alternatives, EconomicImpact = EconomicImpact }; }
public record BudgetRequestInput(int ProjectId, string Title, string WorkDescription, int ProviderId, DateTimeOffset RequestedAtUtc, CommunicationChannel Channel, DateTimeOffset? ExpectedDeadlineUtc, BudgetRequestStatus Status, bool RequiresVisit, int? PrimaryWorkItemId = null, int? SourceCommunicationId = null, int? SourceNoteId = null, int? SourceTaskId = null) { public BudgetRequest ToBudgetRequest() => new() { ProjectId = ProjectId, Title = Title, WorkDescription = WorkDescription, ProviderId = ProviderId, RequestedAtUtc = RequestedAtUtc.ToUniversalTime(), Channel = Channel, ExpectedDeadlineUtc = ExpectedDeadlineUtc?.ToUniversalTime(), Status = Status, RequiresVisit = RequiresVisit, PrimaryWorkItemId = PrimaryWorkItemId, SourceCommunicationId = SourceCommunicationId, SourceNoteId = SourceNoteId, SourceTaskId = SourceTaskId }; }
public record BudgetRequestStatusUpdate(BudgetRequestStatus Status);
public record QuoteLineInput(string Concept, string? Description, decimal Quantity, string Unit, decimal UnitPrice, decimal TaxRate, TradeCategory Category, int? WorkItemId, bool Optional, LineInclusionStatus InclusionStatus);
public record QuoteInput(int ProjectId, string Reference, int ProviderId, DateTimeOffset IssuedAtUtc, DateTimeOffset ReceivedAtUtc, DateTimeOffset? ValidUntilUtc, QuoteStatus Status, decimal Discounts, string Currency, string? EstimatedDuration, string? PaymentTerms, string? Warranty, string? Exclusions, string? Notes, int? BudgetRequestId, QuoteLineInput[] Lines, int? PrimaryWorkItemId = null) { public Quote ToQuote() => new() { ProjectId = ProjectId, Reference = Reference, ProviderId = ProviderId, IssuedAtUtc = IssuedAtUtc.ToUniversalTime(), ReceivedAtUtc = ReceivedAtUtc.ToUniversalTime(), ValidUntilUtc = ValidUntilUtc?.ToUniversalTime(), Status = Status, Discounts = Discounts, Currency = Currency, EstimatedDuration = EstimatedDuration, PaymentTerms = PaymentTerms, Warranty = Warranty, Exclusions = Exclusions, Notes = Notes, BudgetRequestId = BudgetRequestId, PrimaryWorkItemId = PrimaryWorkItemId, Lines = Lines.Select(l => new QuoteLine { Concept = l.Concept, Description = l.Description, Quantity = l.Quantity, Unit = l.Unit, UnitPrice = l.UnitPrice, TaxRate = l.TaxRate, Category = l.Category, WorkItemId = l.WorkItemId, Optional = l.Optional, InclusionStatus = l.InclusionStatus }).ToList() }; }
public record ComparisonInput(int ProjectId, string Title, int[] QuoteIds, string[] Concepts) { public QuoteComparison ToComparison() => new() { ProjectId = ProjectId, Title = Title, Entries = QuoteIds.Select(id => new QuoteComparisonEntry { QuoteId = id, State = OfferState.Candidate }).ToList(), Concepts = Concepts.Select(c => new ComparisonConcept { Name = c, Required = true }).ToList() }; }
public record InvoiceLineInput(string Concept, decimal Quantity, decimal UnitPrice, decimal TaxRate);
public record InvoiceInput(int ProjectId, string Number, int SupplierId, DateTimeOffset IssueDateUtc, DateTimeOffset ReceivedAtUtc, DateTimeOffset? DueDateUtc, InvoiceStatus Status, int? QuoteId, string? Notes, InvoiceLineInput[] Lines, int? PrimaryWorkItemId = null) { public Invoice ToInvoice() => new() { ProjectId = ProjectId, Number = Number, SupplierId = SupplierId, IssueDateUtc = IssueDateUtc.ToUniversalTime(), ReceivedAtUtc = ReceivedAtUtc.ToUniversalTime(), DueDateUtc = DueDateUtc?.ToUniversalTime(), Status = Status, QuoteId = QuoteId, Notes = Notes, PrimaryWorkItemId = PrimaryWorkItemId, Lines = Lines.Select(l => new InvoiceLine { Concept = l.Concept, Quantity = l.Quantity, UnitPrice = l.UnitPrice, TaxRate = l.TaxRate }).ToList() }; }
public record PaymentInput(int InvoiceId, DateTimeOffset PaidAtUtc, decimal Amount, PaymentMethod Method, string? Reference, string? Notes) { public Payment ToPayment(int projectId) => new() { ProjectId = projectId, InvoiceId = InvoiceId, PaidAtUtc = PaidAtUtc.ToUniversalTime(), Amount = Amount, Method = Method, Reference = Reference, Notes = Notes }; }
public record DocumentInput(string Title, string? Description, DocumentType Type);
public record InvoiceLineDto(int Id, string Concept, decimal Quantity, decimal UnitPrice, decimal TaxRate, decimal Total);
public record PaymentDto(int Id, int InvoiceId, DateTimeOffset PaidAtUtc, decimal Amount, PaymentMethod Method, string? Reference, string? Notes);
public record ContactSummaryDto(int Id, string Name, string? Surname, string? CompanyName, string? DisplayName, TradeCategory Trade, ContactStatus Status);
public record InvoiceDto(int Id, int ProjectId, string Number, int SupplierId, ContactSummaryDto? Supplier, InvoiceStatus Status, decimal Subtotal, decimal Taxes, decimal Total, DateTimeOffset IssueDateUtc, DateTimeOffset ReceivedAtUtc, DateTimeOffset? DueDateUtc, int? QuoteId, int? PrimaryWorkItemId, string? Notes, List<InvoiceLineDto> Lines, List<PaymentDto> Payments);
public record InvoiceRowDto(InvoiceDto Invoice, InvoiceBalance Balance);
public record EntityLinkInput(int ProjectId, string SourceType, int SourceId, string TargetType, int TargetId, LinkType Type, string? Description) { public EntityLink ToEntityLink() => new() { ProjectId = ProjectId, SourceType = SourceType, SourceId = SourceId, TargetType = TargetType, TargetId = TargetId, Type = Type, Description = Description }; }
public record NoteReferenceInput(string TargetEntityType, int TargetEntityId);
public record NoteInput(int ProjectId, string Body, DateTimeOffset OccurredAt, int? PrimaryWorkItemId, int? PrimaryContactId, bool IsPinned, NoteReferenceInput[] References)
{
    public Note ToNote(int userId) => new()
    {
        ProjectId = ProjectId,
        Body = Body,
        OccurredAt = OccurredAt.ToUniversalTime(),
        CreatedAt = DateTimeOffset.UtcNow,
        UpdatedAt = DateTimeOffset.UtcNow,
        AuthorUserId = userId,
        PrimaryWorkItemId = PrimaryWorkItemId,
        PrimaryContactId = PrimaryContactId,
        IsPinned = IsPinned,
        References = References.Select(r => new NoteReference { TargetEntityType = r.TargetEntityType, TargetEntityId = r.TargetEntityId }).ToList()
    };
}
public record NotePromotionInput(string TargetType, string? Title);

public static class TextTools
{
    public static string TitleFrom(string body)
    {
        var text = body.Replace('\n', ' ').Trim();
        return text.Length <= 72 ? text : text[..72].TrimEnd() + "...";
    }
}

public record ContextItem(string Role, string EntityType, int EntityId, string Label, string? Detail, bool Legacy = false);
public record EntityContextDto(ContextItem[] Structured, ContextItem[] Legacy);

public static class EntityContext
{
    public static async Task<EntityContextDto> BuildAsync(AppDbContext db, int projectId, string entityType, int entityId)
    {
        var structured = new List<ContextItem>();
        async Task Add(string role, string type, int? id, string? detail = null)
        {
            if (id is null or <= 0) return;
            var label = await LabelAsync(db, type, id.Value);
            if (label is not null) structured.Add(new ContextItem(role, type, id.Value, label, detail));
        }

        switch (entityType)
        {
            case "Task":
                if (await db.Tasks.Include(t => t.Contact).FirstOrDefaultAsync(t => t.ProjectId == projectId && t.Id == entityId) is { } task)
                {
                    await Add("Partida principal", "WorkItem", task.PrimaryWorkItemId);
                    await Add("Contacto", "Contact", task.ContactId);
                    await Add("Incidencia asociada", "Issue", task.IssueId);
                }
                break;
            case "Issue":
                if (await db.Issues.FirstOrDefaultAsync(i => i.ProjectId == projectId && i.Id == entityId) is { } issue)
                {
                    await Add("Partida afectada", "WorkItem", issue.PrimaryWorkItemId);
                    await Add("Reportada por", "Contact", issue.DetectedByContactId);
                }
                break;
            case "Intervention":
                if (await db.Interventions.FirstOrDefaultAsync(i => i.ProjectId == projectId && i.Id == entityId) is { } intervention)
                {
                    await Add("Partida principal", "WorkItem", intervention.PrimaryWorkItemId);
                    await Add("Proveedor", "Contact", intervention.ProviderId);
                    await Add("Cita asociada", "Appointment", intervention.AppointmentId);
                    await Add("Presupuesto origen", "Quote", intervention.OriginQuoteId);
                }
                break;
            case "BudgetRequest":
                if (await db.BudgetRequests.FirstOrDefaultAsync(r => r.ProjectId == projectId && r.Id == entityId) is { } request)
                {
                    await Add("Partida principal", "WorkItem", request.PrimaryWorkItemId);
                    await Add("Proveedor", "Contact", request.ProviderId);
                    await Add("Comunicación origen", "Communication", request.SourceCommunicationId);
                    await Add("Nota origen", "Note", request.SourceNoteId);
                    await Add("Tarea origen", "Task", request.SourceTaskId);
                }
                break;
            case "Quote":
                if (await db.Quotes.FirstOrDefaultAsync(q => q.ProjectId == projectId && q.Id == entityId) is { } quote)
                {
                    await Add("Partida principal", "WorkItem", quote.PrimaryWorkItemId);
                    await Add("Proveedor", "Contact", quote.ProviderId);
                    await Add("Solicitud origen", "BudgetRequest", quote.BudgetRequestId);
                }
                break;
            case "Invoice":
                if (await db.Invoices.FirstOrDefaultAsync(i => i.ProjectId == projectId && i.Id == entityId) is { } invoice)
                {
                    await Add("Partida principal", "WorkItem", invoice.PrimaryWorkItemId);
                    await Add("Proveedor", "Contact", invoice.SupplierId);
                    await Add("Presupuesto origen", "Quote", invoice.QuoteId);
                }
                break;
            case "Appointment":
                if (await db.Appointments.FirstOrDefaultAsync(a => a.ProjectId == projectId && a.Id == entityId) is { } appointment)
                {
                    await Add("Partida principal", "WorkItem", appointment.PrimaryWorkItemId);
                    await Add("Contacto", "Contact", appointment.ContactId);
                    await Add("Intervención", "Intervention", appointment.InterventionId);
                }
                break;
            case "Communication":
                if (await db.Communications.FirstOrDefaultAsync(c => c.ProjectId == projectId && c.Id == entityId) is { } communication)
                {
                    await Add("Partida principal", "WorkItem", communication.PrimaryWorkItemId);
                    await Add("Contacto", "Contact", communication.ContactId);
                }
                break;
            case "WorkItem":
                structured.AddRange(await db.Tasks.Where(t => t.ProjectId == projectId && t.PrimaryWorkItemId == entityId).OrderByDescending(t => t.Id).Take(5).Select(t => new ContextItem("Tarea", "Task", t.Id, t.Title, null, false)).ToListAsync());
                structured.AddRange(await db.Issues.Where(i => i.ProjectId == projectId && i.PrimaryWorkItemId == entityId).OrderByDescending(i => i.Id).Take(5).Select(i => new ContextItem("Incidencia", "Issue", i.Id, i.Title, null, false)).ToListAsync());
                structured.AddRange(await db.Interventions.Where(i => i.ProjectId == projectId && i.PrimaryWorkItemId == entityId).OrderByDescending(i => i.Id).Take(5).Select(i => new ContextItem("Intervención", "Intervention", i.Id, i.Title, null, false)).ToListAsync());
                break;
            case "Contact":
                structured.AddRange(await db.Tasks.Where(t => t.ProjectId == projectId && t.ContactId == entityId).OrderByDescending(t => t.Id).Take(5).Select(t => new ContextItem("Tarea", "Task", t.Id, t.Title, null, false)).ToListAsync());
                structured.AddRange(await db.BudgetRequests.Where(r => r.ProjectId == projectId && r.ProviderId == entityId).OrderByDescending(r => r.Id).Take(5).Select(r => new ContextItem("Solicitud", "BudgetRequest", r.Id, r.Title, null, false)).ToListAsync());
                structured.AddRange(await db.Interventions.Where(i => i.ProjectId == projectId && i.ProviderId == entityId).OrderByDescending(i => i.Id).Take(5).Select(i => new ContextItem("Intervención", "Intervention", i.Id, i.Title, null, false)).ToListAsync());
                break;
        }

        var legacyRows = await db.EntityLinks.Where(l => l.ProjectId == projectId && ((l.SourceType == entityType && l.SourceId == entityId) || (l.TargetType == entityType && l.TargetId == entityId))).OrderByDescending(l => l.CreatedAtUtc).ToListAsync();
        var legacy = new List<ContextItem>();
        foreach (var link in legacyRows)
        {
            var targetType = link.SourceType == entityType && link.SourceId == entityId ? link.TargetType : link.SourceType;
            var targetId = link.SourceType == entityType && link.SourceId == entityId ? link.TargetId : link.SourceId;
            var label = await LabelAsync(db, targetType, targetId) ?? $"{targetType} #{targetId}";
            legacy.Add(new ContextItem($"Relación pendiente: {LinkTypeLabel(link.Type)}", targetType, targetId, label, link.Description, true));
        }
        return new EntityContextDto(structured.ToArray(), legacy.ToArray());
    }

    public static async Task<string?> LabelAsync(AppDbContext db, string type, int id) => type switch
    {
        "Project" => (await db.Projects.FindAsync(id))?.Name,
        "WorkItem" => (await db.WorkItems.FindAsync(id))?.Title,
        "Contact" => (await db.Contacts.FindAsync(id))?.DisplayName,
        "Communication" => (await db.Communications.FindAsync(id))?.Summary,
        "Task" => (await db.Tasks.FindAsync(id))?.Title,
        "Appointment" => (await db.Appointments.FindAsync(id))?.Title,
        "Intervention" => (await db.Interventions.FindAsync(id))?.Title,
        "Issue" => (await db.Issues.FindAsync(id))?.Title,
        "Requirement" => (await db.Requirements.FindAsync(id))?.Text,
        "Decision" => (await db.Decisions.FindAsync(id))?.Title,
        "BudgetRequest" => (await db.BudgetRequests.FindAsync(id))?.Title,
        "Quote" => (await db.Quotes.FindAsync(id))?.Reference,
        "Invoice" => (await db.Invoices.FindAsync(id))?.Number,
        "Payment" => (await db.Payments.FindAsync(id))?.ActivityTitle,
        "Document" => (await db.Documents.FindAsync(id))?.Title,
        "Note" => TextTools.TitleFrom((await db.Notes.FindAsync(id))?.Body ?? ""),
        _ => null
    };

    public static string LinkTypeLabel(LinkType type) => type switch
    {
        LinkType.OriginatedBy => "Originado por",
        LinkType.Generated => "Generó",
        LinkType.RelatedTo => "Relacionado con",
        LinkType.Resolves => "Resuelve",
        LinkType.Blocks => "Bloquea",
        LinkType.Replaces => "Sustituye a",
        _ => type.ToString()
    };
}

public record RelationMigrationPreviewItem(int EntityLinkId, string Source, string Target, string OldType, string Proposal, string Status);

public static class RelationMigration
{
    public static async Task<List<RelationMigrationPreviewItem>> BuildPreviewAsync(AppDbContext db, int projectId)
    {
        var links = await db.EntityLinks.Where(l => l.ProjectId == projectId).OrderBy(l => l.Id).ToListAsync();
        var existing = await db.RelationMigrationReviews.Where(r => r.ProjectId == projectId).ToDictionaryAsync(r => r.EntityLinkId);
        var items = new List<RelationMigrationPreviewItem>();
        foreach (var link in links)
        {
            var source = await EntityContext.LabelAsync(db, link.SourceType, link.SourceId) ?? $"{link.SourceType} #{link.SourceId}";
            var target = await EntityContext.LabelAsync(db, link.TargetType, link.TargetId) ?? $"{link.TargetType} #{link.TargetId}";
            var proposal = ProposalFor(link);
            var status = existing.TryGetValue(link.Id, out var review) ? review.Status : "DryRun";
            items.Add(new RelationMigrationPreviewItem(link.Id, $"{link.SourceType}: {source}", $"{link.TargetType}: {target}", EntityContext.LinkTypeLabel(link.Type), proposal, status));
        }
        return items;
    }

    public static async Task<List<RelationMigrationPreviewItem>> RunAsync(AppDbContext db, int projectId, int userId)
    {
        var links = await db.EntityLinks.Where(l => l.ProjectId == projectId).OrderBy(l => l.Id).ToListAsync();
        foreach (var link in links)
        {
            if (await db.RelationMigrationReviews.AnyAsync(r => r.EntityLinkId == link.Id)) continue;
            var source = await EntityContext.LabelAsync(db, link.SourceType, link.SourceId) ?? $"{link.SourceType} #{link.SourceId}";
            var target = await EntityContext.LabelAsync(db, link.TargetType, link.TargetId) ?? $"{link.TargetType} #{link.TargetId}";
            var review = new RelationMigrationReview { ProjectId = projectId, EntityLinkId = link.Id, SourceLabel = source, TargetLabel = target, OldType = link.Type, OldContext = link.Description, Proposal = ProposalFor(link), Status = "PendingReview" };
            if (TryTaskIssue(link, out var taskId, out var issueId))
            {
                var task = await db.Tasks.FindAsync(taskId);
                if (task is not null && task.IssueId is null)
                {
                    task.IssueId = issueId;
                    review.Status = "Applied";
                    review.AppliedAtUtc = DateTimeOffset.UtcNow;
                    await Activity.Record(db, projectId, "Task", task.Id, $"Relación anterior migrada", $"Tarea vinculada a incidencia #{issueId}", userId);
                }
            }
            else
            {
                var note = new Note
                {
                    ProjectId = projectId,
                    Body = $"Relación anterior: {source} - {EntityContext.LinkTypeLabel(link.Type)} - {target}",
                    OccurredAt = link.CreatedAtUtc,
                    CreatedAt = link.CreatedAtUtc,
                    UpdatedAt = DateTimeOffset.UtcNow,
                    AuthorUserId = userId,
                    SourceEntityLinkId = link.Id,
                    References =
                    [
                        new NoteReference { TargetEntityType = link.SourceType, TargetEntityId = link.SourceId },
                        new NoteReference { TargetEntityType = link.TargetType, TargetEntityId = link.TargetId }
                    ]
                };
                db.Notes.Add(note);
                await db.SaveChangesAsync();
                review.CreatedNoteId = note.Id;
                review.Status = "ConvertedToNote";
            }
            db.RelationMigrationReviews.Add(review);
            await db.SaveChangesAsync();
        }
        return await BuildPreviewAsync(db, projectId);
    }

    private static string ProposalFor(EntityLink link)
    {
        if (TryTaskIssue(link, out _, out _)) return "Migrar a incidencia principal de la tarea y conservar el vínculo anterior como referencia técnica.";
        if (link.Type is LinkType.Generated or LinkType.OriginatedBy or LinkType.RelatedTo) return "Convertir a nota histórica con referencias simples.";
        return "Conservar como relación avanzada para revisión manual.";
    }

    private static bool TryTaskIssue(EntityLink link, out int taskId, out int issueId)
    {
        taskId = 0;
        issueId = 0;
        var semantic = link.Type is LinkType.OriginatedBy or LinkType.Resolves;
        if (!semantic) return false;
        if (link.SourceType == "Task" && link.TargetType == "Issue") { taskId = link.SourceId; issueId = link.TargetId; return true; }
        if (link.SourceType == "Issue" && link.TargetType == "Task") { taskId = link.TargetId; issueId = link.SourceId; return true; }
        return false;
    }
}

public record StoredDocument(string StoredFileName, string MimeType, long SizeBytes, string Sha256);
public interface IDocumentStorage { Task<StoredDocument> SaveAsync(IFormFile file); Task<Stream> OpenReadAsync(string storedName); }
public class LocalDocumentStorage(IConfiguration config) : IDocumentStorage
{
    private readonly string _root = Environment.GetEnvironmentVariable("DOCUMENT_ROOT") ?? config["DocumentRoot"] ?? "/data/documents";
    private readonly long _max = long.TryParse(Environment.GetEnvironmentVariable("MAX_UPLOAD_BYTES"), out var v) ? v : 25 * 1024 * 1024;
    private static readonly HashSet<string> Allowed = new(StringComparer.OrdinalIgnoreCase) { ".pdf", ".jpg", ".jpeg", ".png", ".webp", ".txt", ".csv", ".doc", ".docx", ".xls", ".xlsx" };
    public async Task<StoredDocument> SaveAsync(IFormFile file)
    {
        if (file.Length > _max) throw new InvalidOperationException("Archivo demasiado grande");
        var ext = Path.GetExtension(file.FileName);
        if (!Allowed.Contains(ext)) throw new InvalidOperationException("Extensión no permitida");
        Directory.CreateDirectory(_root);
        var stored = $"{Guid.NewGuid():N}{ext.ToLowerInvariant()}";
        var path = Path.Combine(_root, stored);
        await using (var output = File.Create(path))
        {
            await file.CopyToAsync(output);
            await output.FlushAsync();
        }
        await using var input = File.OpenRead(path);
        var hash = await SHA256.HashDataAsync(input);
        return new StoredDocument(stored, file.ContentType, file.Length, Convert.ToHexString(hash));
    }
    public Task<Stream> OpenReadAsync(string storedName)
    {
        if (storedName.Contains('/') || storedName.Contains('\\')) throw new InvalidOperationException("Ruta inválida");
        return Task.FromResult<Stream>(File.OpenRead(Path.Combine(_root, storedName)));
    }
}

public static class PasswordHasher
{
    public static string Hash(string password)
    {
        var salt = RandomNumberGenerator.GetBytes(16);
        var key = Rfc2898DeriveBytes.Pbkdf2(password, salt, 210_000, HashAlgorithmName.SHA256, 32);
        return $"pbkdf2-sha256$210000${Convert.ToBase64String(salt)}${Convert.ToBase64String(key)}";
    }
    public static bool Verify(string password, string hash)
    {
        var parts = hash.Split('$');
        if (parts.Length != 4) return false;
        var iterations = int.Parse(parts[1], CultureInfo.InvariantCulture);
        var salt = Convert.FromBase64String(parts[2]);
        var expected = Convert.FromBase64String(parts[3]);
        var actual = Rfc2898DeriveBytes.Pbkdf2(password, salt, iterations, HashAlgorithmName.SHA256, expected.Length);
        return CryptographicOperations.FixedTimeEquals(expected, actual);
    }
}
public static class ClaimsPrincipalExtensions { public static int UserId(this ClaimsPrincipal user) => int.Parse(user.FindFirstValue(ClaimTypes.NameIdentifier) ?? "0", CultureInfo.InvariantCulture); }

public static class ApiDtos
{
    public static InvoiceRowDto InvoiceRow(Invoice invoice) => new(Invoice(invoice), EconomyCalculator.InvoiceBalance(invoice));

    public static InvoiceDto Invoice(Invoice invoice) => new(
        invoice.Id,
        invoice.ProjectId,
        invoice.Number,
        invoice.SupplierId,
        Contact(invoice.Supplier),
        invoice.Status,
        invoice.Subtotal,
        invoice.Taxes,
        invoice.Total,
        invoice.IssueDateUtc,
        invoice.ReceivedAtUtc,
        invoice.DueDateUtc,
        invoice.QuoteId,
        invoice.PrimaryWorkItemId,
        invoice.Notes,
        invoice.Lines.Select(Line).ToList(),
        invoice.Payments.Select(Payment).ToList());

    private static InvoiceLineDto Line(InvoiceLine line) => new(line.Id, line.Concept, line.Quantity, line.UnitPrice, line.TaxRate, line.Total);

    public static PaymentDto Payment(Payment payment) => new(payment.Id, payment.InvoiceId, payment.PaidAtUtc, payment.Amount, payment.Method, payment.Reference, payment.Notes);

    private static ContactSummaryDto? Contact(Contact? contact) => contact is null
        ? null
        : new(contact.Id, contact.Name, contact.Surname, contact.CompanyName, contact.DisplayName, contact.Trade, contact.Status);
}

public static class SearchIndex
{
    public static string[] Terms(string query) => Normalize(query).Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

    public static bool Matches(string query, params object?[] values)
    {
        var terms = Terms(query);
        if (terms.Length == 0) return false;
        var haystack = Normalize(string.Join(' ', values.Where(v => v is not null)));
        return terms.All(haystack.Contains);
    }

    public static string Trade(TradeCategory trade) => trade switch
    {
        TradeCategory.Electricity => "electricidad electrica electricista electrico",
        TradeCategory.Masonry => "albanileria obra",
        TradeCategory.Plumbing => "fontaneria fontanero",
        TradeCategory.Carpentry => "carpinteria carpintero",
        TradeCategory.Architecture => "arquitectura arquitecto",
        TradeCategory.Painting => "pintura pintor",
        TradeCategory.Hvac => "climatizacion aire calefaccion",
        TradeCategory.Windows => "ventanas",
        TradeCategory.Kitchen => "cocina",
        TradeCategory.Administration => "administracion",
        TradeCategory.ElectricDistributor => "distribuidora electrica cups contador",
        _ => "otros"
    };

    private static string Normalize(string value)
    {
        var normalized = value.ToLowerInvariant().Normalize(System.Text.NormalizationForm.FormD);
        var chars = normalized
            .Where(c => CharUnicodeInfo.GetUnicodeCategory(c) != System.Globalization.UnicodeCategory.NonSpacingMark)
            .Select(c => char.IsLetterOrDigit(c) ? c : ' ')
            .ToArray();
        return new string(chars).Normalize(System.Text.NormalizationForm.FormC);
    }
}

public static class DomainRules
{
    public static bool IsTaskOverdue(TaskItem task, DateTimeOffset now) => task.Status is not (TaskStatus.Completed or TaskStatus.Cancelled) && task.DueUtc is not null && task.DueUtc < now;
    public static bool IsTaskDueToday(TaskItem task, DateTimeOffset now, string timezone)
    {
        if (task.DueUtc is null || task.Status is TaskStatus.Completed or TaskStatus.Cancelled) return false;
        var tz = TimeZoneInfo.FindSystemTimeZoneById(timezone);
        return TimeZoneInfo.ConvertTime(task.DueUtc.Value, tz).Date == TimeZoneInfo.ConvertTime(now, tz).Date;
    }
    public static bool IsBudgetRequestOverdue(BudgetRequest request, DateTimeOffset now) => request.Status == BudgetRequestStatus.Requested && request.ExpectedDeadlineUtc is not null && request.ExpectedDeadlineUtc < now;
    public static Task<bool> HasEntityLinks(AppDbContext db, string entityType, int entityId) =>
        db.EntityLinks.AnyAsync(l => (l.SourceType == entityType && l.SourceId == entityId) || (l.TargetType == entityType && l.TargetId == entityId));
    public static async Task<bool> HasContactRelations(AppDbContext db, int contactId) =>
        await db.Communications.AnyAsync(x => x.ContactId == contactId) ||
        await db.Tasks.AnyAsync(x => x.ContactId == contactId) ||
        await db.Appointments.AnyAsync(x => x.ContactId == contactId) ||
        await db.BudgetRequests.AnyAsync(x => x.ProviderId == contactId) ||
        await db.Quotes.AnyAsync(x => x.ProviderId == contactId) ||
        await db.Invoices.AnyAsync(x => x.SupplierId == contactId) ||
        await db.Interventions.AnyAsync(x => x.ProviderId == contactId) ||
        await db.Issues.AnyAsync(x => x.DetectedByContactId == contactId) ||
        await db.Requirements.AnyAsync(x => x.CommunicatedToContactId == contactId) ||
        await db.Notes.AnyAsync(x => x.PrimaryContactId == contactId) ||
        await db.WorkItemContacts.AnyAsync(x => x.ContactId == contactId) ||
        await HasEntityLinks(db, "Contact", contactId);
    public static async Task<string?> ValidateTaskAsync(AppDbContext db, TaskItem task)
    {
        if (task.ProgressPercent is < 0 or > 100) return "El progreso debe estar entre 0 y 100.";
        if (task.PlannedStartAt is not null && task.PlannedEndAt is not null && task.PlannedEndAt < task.PlannedStartAt) return "La fecha final prevista no puede ser anterior al inicio previsto.";
        if (task.ActualStartAt is not null && task.ActualEndAt is not null && task.ActualEndAt < task.ActualStartAt) return "La fecha final real no puede ser anterior al inicio real.";
        if (task.Status == TaskStatus.Completed && task.ProgressPercent < 100) return "Una tarea completada debe tener progreso 100.";
        if (task.Status == TaskStatus.Pending && task.ActualEndAt is not null) return "Una tarea no iniciada no debería tener fecha final real.";
        if (task.ParentTaskId == task.Id || await WouldCreateTaskHierarchyCycle(db, task.Id, task.ParentTaskId)) return "Jerarquía cíclica.";
        return null;
    }
    public static async Task<bool> WouldCreateTaskHierarchyCycle(AppDbContext db, int taskId, int? parentId)
    {
        if (parentId is null) return false;
        if (taskId == parentId) return true;
        var tasks = await db.Tasks.AsNoTracking().Select(t => new { t.Id, t.ParentTaskId }).ToListAsync();
        var current = parentId;
        var seen = new HashSet<int>();
        while (current is not null)
        {
            if (!seen.Add(current.Value)) return true;
            if (current == taskId) return true;
            current = tasks.FirstOrDefault(t => t.Id == current)?.ParentTaskId;
        }
        return false;
    }
    public static async Task<bool> WouldCreateTaskDependencyCycle(AppDbContext db, int predecessorId, int successorId)
    {
        if (predecessorId == successorId) return true;
        var edges = await db.TaskDependencies.AsNoTracking().ToListAsync();
        var stack = new Stack<int>();
        stack.Push(successorId);
        while (stack.Count > 0)
        {
            var current = stack.Pop();
            if (current == predecessorId) return true;
            foreach (var next in edges.Where(e => e.PredecessorTaskId == current).Select(e => e.SuccessorTaskId)) stack.Push(next);
        }
        return false;
    }
    public static async Task<bool> WouldCreateWorkItemCycle(AppDbContext db, int workItemId, int dependsOnId)
    {
        if (workItemId == dependsOnId) return true;
        var edges = await db.WorkItemDependencies.AsNoTracking().ToListAsync();
        var stack = new Stack<int>();
        stack.Push(dependsOnId);
        while (stack.Count > 0)
        {
            var current = stack.Pop();
            if (current == workItemId) return true;
            foreach (var next in edges.Where(e => e.WorkItemId == current).Select(e => e.DependsOnWorkItemId)) stack.Push(next);
        }
        return false;
    }
}

public record TaskRelationsDto(List<Issue> Issues, List<Intervention> Interventions, List<BudgetRequest> BudgetRequests, List<Quote> Quotes);
public static class TaskRelationReader
{
    public static async Task<TaskRelationsDto> BuildAsync(AppDbContext db, TaskItem task)
    {
        var issueIds = new HashSet<int>();
        if (task.IssueId is int issueId) issueIds.Add(issueId);
        var taskLinks = await db.EntityLinks.AsNoTracking().Where(l => (l.SourceType == "Task" && l.SourceId == task.Id) || (l.TargetType == "Task" && l.TargetId == task.Id)).ToListAsync();
        foreach (var link in taskLinks)
        {
            if (link.SourceType == "Issue") issueIds.Add(link.SourceId);
            if (link.TargetType == "Issue") issueIds.Add(link.TargetId);
        }
        var issues = issueIds.Count == 0 ? [] : await db.Issues.Where(i => issueIds.Contains(i.Id)).ToListAsync();
        var interventionIds = taskLinks.Select(l => l.SourceType == "Intervention" ? l.SourceId : l.TargetType == "Intervention" ? l.TargetId : 0).Where(id => id > 0).Distinct().ToList();
        var interventions = interventionIds.Count == 0 ? [] : await db.Interventions.Include(i => i.Provider).Where(i => interventionIds.Contains(i.Id)).ToListAsync();
        var requestIds = taskLinks.Select(l => l.SourceType == "BudgetRequest" ? l.SourceId : l.TargetType == "BudgetRequest" ? l.TargetId : 0).Where(id => id > 0).Distinct().ToList();
        var requests = requestIds.Count == 0 ? [] : await db.BudgetRequests.Where(r => requestIds.Contains(r.Id)).ToListAsync();
        var quoteIds = taskLinks.Select(l => l.SourceType == "Quote" ? l.SourceId : l.TargetType == "Quote" ? l.TargetId : 0).Where(id => id > 0).Distinct().ToList();
        var quotes = quoteIds.Count == 0 ? [] : await db.Quotes.Include(q => q.Provider).Where(q => quoteIds.Contains(q.Id)).ToListAsync();
        return new TaskRelationsDto(issues, interventions, requests, quotes);
    }
}

public record InvoiceBalance(decimal Total, decimal Paid, decimal Pending, bool Overdue);
public record ProjectEconomy(decimal TargetBudget, decimal Estimated, decimal Committed, decimal Invoiced, decimal Paid, decimal PendingToInvoice, decimal PendingToPay, decimal ForecastFinal, decimal Deviation, decimal DeviationPercent, decimal ContingencyRemaining);
public static class EconomyCalculator
{
    public static InvoiceBalance InvoiceBalance(Invoice invoice)
    {
        var paid = invoice.Payments.Sum(p => p.Amount);
        var pending = Math.Max(invoice.Total - paid, 0);
        return new InvoiceBalance(invoice.Total, paid, pending, pending > 0 && invoice.DueDateUtc < DateTimeOffset.UtcNow);
    }
    public static ProjectEconomy ProjectSummary(Project project, IEnumerable<WorkItem> workItems, IEnumerable<Quote> quotes, IEnumerable<Invoice> invoices)
    {
        var estimated = workItems.Sum(w => w.EstimatedCost);
        var committed = quotes.Where(q => q.Status == QuoteStatus.Accepted).Sum(q => q.Total);
        var inv = invoices.Where(i => i.Status != InvoiceStatus.Cancelled).ToList();
        var invoiced = inv.Sum(i => i.Total);
        var paid = inv.Sum(i => i.Payments.Sum(p => p.Amount));
        var forecast = Math.Max(Math.Max(estimated, committed), invoiced);
        var deviation = forecast - project.TargetBudget;
        var deviationPercent = project.TargetBudget > 0 ? Math.Round(deviation / project.TargetBudget * 100m, 2) : 0;
        var contingencyRemaining = project.ContingencyFund - Math.Max(deviation, 0);
        return new ProjectEconomy(project.TargetBudget, estimated, committed, invoiced, paid, Math.Max(committed - invoiced, 0), Math.Max(invoiced - paid, 0), forecast, deviation, deviationPercent, contingencyRemaining);
    }
}
public static class ComparisonDto
{
    public static object From(QuoteComparison comparison)
    {
        var required = comparison.Concepts.Where(c => c.Required).Select(c => c.Name.ToLowerInvariant()).ToList();
        return new
        {
            comparison.Id,
            comparison.Title,
            comparison.SelectedQuoteId,
            comparison.DecisionJustification,
            concepts = comparison.Concepts,
            entries = comparison.Entries.Select(e =>
            {
                var quote = e.Quote!;
                var included = quote.Lines.Where(l => l.InclusionStatus == LineInclusionStatus.Included).Select(l => l.Concept.ToLowerInvariant()).ToList();
                var missing = required.Where(c => !included.Any(i => i.Contains(c) || c.Contains(i))).ToList();
                return new { e.Id, e.State, e.KnownAdditionalCosts, e.InternalRating, quote.Reference, provider = quote.Provider?.DisplayName, quote.Subtotal, quote.Taxes, quote.Total, normalizedTotal = quote.Total + e.KnownAdditionalCosts, quote.ValidUntilUtc, quote.Warranty, quote.PaymentTerms, included = quote.Lines.Where(l => l.InclusionStatus == LineInclusionStatus.Included), excluded = quote.Lines.Where(l => l.InclusionStatus == LineInclusionStatus.Excluded), pending = quote.Lines.Where(l => l.InclusionStatus == LineInclusionStatus.PendingClarification), missingRequired = missing, comparable = missing.Count == 0 };
            })
        };
    }
}

public static class Activity { public static async Task Record(AppDbContext db, int projectId, string entityType, int entityId, string action, string summary, int? userId) { db.ActivityEvents.Add(new ActivityEvent { ProjectId = projectId, EntityType = entityType, EntityId = entityId, Action = action, Summary = summary, UserId = userId }); await db.SaveChangesAsync(); } }
public static class Stats
{
    public static async Task<object> ContactStats(AppDbContext db, int contactId)
    {
        var quoted = await db.Quotes.Where(q => q.ProviderId == contactId).SumAsync(q => q.Total);
        var committed = await db.Quotes.Where(q => q.ProviderId == contactId && q.Status == QuoteStatus.Accepted).SumAsync(q => q.Total);
        var invoiced = await db.Invoices.Where(i => i.SupplierId == contactId && i.Status != InvoiceStatus.Cancelled).SumAsync(i => i.Total);
        var paid = await db.Payments.Where(p => p.Invoice!.SupplierId == contactId).SumAsync(p => p.Amount);
        return new { quoted, committed, invoiced, paid };
    }
}

public class AlertRefreshWorker(IServiceProvider services) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            using var scope = services.CreateScope();
            await AlertService.RefreshAsync(scope.ServiceProvider.GetRequiredService<AppDbContext>());
            await Task.Delay(TimeSpan.FromMinutes(15), stoppingToken);
        }
    }
}
public static class AlertService
{
    public static async Task RefreshAsync(AppDbContext db)
    {
        db.Alerts.RemoveRange(db.Alerts.Where(a => !a.Resolved));
        var now = DateTimeOffset.UtcNow;
        foreach (var task in await db.Tasks.Where(t => t.Status != TaskStatus.Completed && t.Status != TaskStatus.Cancelled).ToListAsync())
        {
            if (DomainRules.IsTaskOverdue(task, now)) db.Alerts.Add(new Alert { ProjectId = task.ProjectId, Title = $"Tarea vencida: {task.Title}", Type = AlertType.OverdueTask, Severity = task.Priority == Priority.Critical ? Severity.Critical : Severity.High, DueUtc = task.DueUtc, EntityType = "Task", EntityId = task.Id });
            else if (task.DueUtc <= now.AddDays(2)) db.Alerts.Add(new Alert { ProjectId = task.ProjectId, Title = $"Tarea próxima: {task.Title}", Type = AlertType.UpcomingTask, Severity = Severity.Medium, DueUtc = task.DueUtc, EntityType = "Task", EntityId = task.Id });
            if (task.Status == TaskStatus.Blocked) db.Alerts.Add(new Alert { ProjectId = task.ProjectId, Title = $"Tarea bloqueada: {task.Title}", Type = AlertType.DependencyUnmet, Severity = Severity.High, EntityType = "Task", EntityId = task.Id });
        }
        foreach (var req in await db.BudgetRequests.Where(r => r.Status == BudgetRequestStatus.Requested).ToListAsync())
            if (DomainRules.IsBudgetRequestOverdue(req, now)) db.Alerts.Add(new Alert { ProjectId = req.ProjectId, Title = $"Solicitud vencida: {req.Title}", Type = AlertType.BudgetRequestNoReply, Severity = Severity.High, DueUtc = req.ExpectedDeadlineUtc, EntityType = "BudgetRequest", EntityId = req.Id });
        foreach (var quote in await db.Quotes.Where(q => q.Status == QuoteStatus.Received || q.Status == QuoteStatus.Reviewing).ToListAsync())
            if (quote.ValidUntilUtc <= now.AddDays(7)) db.Alerts.Add(new Alert { ProjectId = quote.ProjectId, Title = $"Presupuesto próximo a caducar: {quote.Reference}", Type = AlertType.QuoteExpiring, Severity = Severity.Medium, DueUtc = quote.ValidUntilUtc, EntityType = "Quote", EntityId = quote.Id });
        foreach (var invoice in await db.Invoices.Include(i => i.Payments).Where(i => i.Status != InvoiceStatus.Paid && i.Status != InvoiceStatus.Cancelled).ToListAsync())
            if (EconomyCalculator.InvoiceBalance(invoice).Overdue) db.Alerts.Add(new Alert { ProjectId = invoice.ProjectId, Title = $"Factura vencida: {invoice.Number}", Type = AlertType.InvoiceOverdue, Severity = Severity.High, DueUtc = invoice.DueDateUtc, EntityType = "Invoice", EntityId = invoice.Id });
        foreach (var app in await db.Appointments.Where(a => a.StartUtc >= now && a.StartUtc <= now.AddDays(2)).ToListAsync())
            db.Alerts.Add(new Alert { ProjectId = app.ProjectId, Title = $"Cita próxima: {app.Title}", Type = AlertType.UpcomingAppointment, Severity = Severity.Medium, DueUtc = app.StartUtc, EntityType = "Appointment", EntityId = app.Id });
        await db.SaveChangesAsync();
    }
}

public static class SeedData
{
    public static async Task EnsureAsync(AppDbContext db)
    {
        if (!await db.Users.AnyAsync())
        {
            var email = (Environment.GetEnvironmentVariable("COMOPS_ADMIN_EMAIL") ?? Environment.GetEnvironmentVariable("REFORMA_ADMIN_EMAIL") ?? "admin@local.test").ToLower();
            var password = Environment.GetEnvironmentVariable("COMOPS_ADMIN_PASSWORD") ?? Environment.GetEnvironmentVariable("REFORMA_ADMIN_PASSWORD") ?? "change-this-password-before-use";
            db.Users.Add(new UserAccount { Email = email, DisplayName = "Administrador local", PasswordHash = PasswordHasher.Hash(password) });
            await db.SaveChangesAsync();
        }

        if (!await db.Projects.AnyAsync())
        {
            db.Projects.Add(new Project
            {
                Name = "Proyecto sin configurar",
                Description = null,
                Location = null,
                Status = ProjectStatus.Planning,
                TargetBudget = 0,
                ContingencyFund = 0,
                Tags = [],
                CreatedAtUtc = DateTimeOffset.UtcNow,
                UpdatedAtUtc = DateTimeOffset.UtcNow
            });
            await db.SaveChangesAsync();
        }

        foreach (var project in await db.Projects.ToListAsync())
        {
            if (await db.TaskCategories.AnyAsync(c => c.ProjectId == project.Id)) continue;
            var names = new[] { "General", "Cocina", "Baño", "Instalaciones", "Documentación y trámites", "Compras y suministros", "Coordinación de gremios", "Repasos y defectos", "Exterior", "Otros" };
            for (var i = 0; i < names.Length; i++) db.TaskCategories.Add(new TaskCategory { ProjectId = project.Id, Name = names[i], SortOrder = i });
        }
        await db.SaveChangesAsync();
    }
}
