using Microsoft.EntityFrameworkCore;
using System.Text.Json;
using Xunit;

public class RulesTests
{
    [Fact]
    public void Invoice_balance_supports_partial_payments()
    {
        var invoice = new Invoice { Total = 1210, DueDateUtc = DateTimeOffset.UtcNow.AddDays(2) };
        invoice.Payments.Add(new Payment { Amount = 400 });
        invoice.Payments.Add(new Payment { Amount = 300 });

        var balance = EconomyCalculator.InvoiceBalance(invoice);

        Assert.Equal(1210, balance.Total);
        Assert.Equal(700, balance.Paid);
        Assert.Equal(510, balance.Pending);
        Assert.False(balance.Overdue);
    }

    [Fact]
    public void Invoice_row_dto_does_not_serialize_payment_invoice_cycles()
    {
        var invoice = new Invoice
        {
            Id = 9,
            ProjectId = 1,
            Number = "F-QA",
            Total = 121,
            SupplierId = 4,
            Supplier = new Contact { Id = 4, ProjectId = 1, Name = "Proveedor" }
        };
        invoice.Payments.Add(new Payment { Id = 3, ProjectId = 1, InvoiceId = 9, Invoice = invoice, Amount = 121, PaidAtUtc = DateTimeOffset.UtcNow });

        var json = JsonSerializer.Serialize(ApiDtos.InvoiceRow(invoice), new JsonSerializerOptions(JsonSerializerDefaults.Web));

        Assert.Contains("\"number\":\"F-QA\"", json);
        Assert.Contains("\"payments\"", json);
        using var document = JsonDocument.Parse(json);
        var payment = document.RootElement.GetProperty("invoice").GetProperty("payments")[0];
        Assert.False(payment.TryGetProperty("invoice", out _));
    }

    [Fact]
    public void Payment_dto_does_not_serialize_invoice_back_reference()
    {
        var invoice = new Invoice { Id = 9, ProjectId = 1, Number = "F-QA" };
        var payment = new Payment { Id = 3, ProjectId = 1, InvoiceId = 9, Invoice = invoice, Amount = 121, PaidAtUtc = DateTimeOffset.UtcNow };
        invoice.Payments.Add(payment);

        var json = JsonSerializer.Serialize(ApiDtos.Payment(payment), new JsonSerializerOptions(JsonSerializerDefaults.Web));

        Assert.Contains("\"invoiceId\":9", json);
        Assert.DoesNotContain("\"invoice\"", json);
    }

    [Fact]
    public void Search_index_matches_accents_multiple_terms_and_trade_aliases()
    {
        Assert.True(SearchIndex.Matches("derivacion electrica", "Derivación individual", SearchIndex.Trade(TradeCategory.Electricity)));
        Assert.True(SearchIndex.Matches("electricidad norte", "Contacto Demo", "Electricidad Norte"));
        Assert.False(SearchIndex.Matches("fontaneria", "Electricidad Norte", SearchIndex.Trade(TradeCategory.Electricity)));
    }

    [Fact]
    public void Project_economy_avoids_double_counting()
    {
        var project = new Project { TargetBudget = 10000, ContingencyFund = 1500 };
        var workItems = new[] { new WorkItem { EstimatedCost = 7000 }, new WorkItem { EstimatedCost = 1200 } };
        var quotes = new[] { new Quote { Status = QuoteStatus.Accepted, Total = 8500 }, new Quote { Status = QuoteStatus.Rejected, Total = 6000 } };
        var invoice = new Invoice { Status = InvoiceStatus.PartiallyPaid, Total = 4000 };
        invoice.Payments.Add(new Payment { Amount = 1500 });

        var summary = EconomyCalculator.ProjectSummary(project, workItems, quotes, new[] { invoice });

        Assert.Equal(8200, summary.Estimated);
        Assert.Equal(8500, summary.Committed);
        Assert.Equal(4000, summary.Invoiced);
        Assert.Equal(1500, summary.Paid);
        Assert.Equal(8500, summary.ForecastFinal);
        Assert.Equal(-1500, summary.Deviation);
    }

    [Fact]
    public void Project_economy_uses_invoiced_when_it_exceeds_committed()
    {
        var project = new Project { TargetBudget = 10000, ContingencyFund = 1500 };
        var quotes = new[] { new Quote { Status = QuoteStatus.Accepted, Total = 6000 } };
        var invoice = new Invoice { Status = InvoiceStatus.Received, Total = 9000 };

        var summary = EconomyCalculator.ProjectSummary(project, Array.Empty<WorkItem>(), quotes, new[] { invoice });

        Assert.Equal(6000, summary.Committed);
        Assert.Equal(9000, summary.Invoiced);
        Assert.Equal(9000, summary.ForecastFinal);
        Assert.Equal(-1000, summary.Deviation);
        Assert.Equal(-10, summary.DeviationPercent);
    }

    [Fact]
    public void Project_economy_reports_unfavorable_deviation_percent()
    {
        var project = new Project { TargetBudget = 10000, ContingencyFund = 1500 };
        var workItems = new[] { new WorkItem { EstimatedCost = 12500 } };

        var summary = EconomyCalculator.ProjectSummary(project, workItems, Array.Empty<Quote>(), Array.Empty<Invoice>());

        Assert.Equal(12500, summary.ForecastFinal);
        Assert.Equal(2500, summary.Deviation);
        Assert.Equal(25, summary.DeviationPercent);
        Assert.Equal(-1000, summary.ContingencyRemaining);
    }

    [Fact]
    public void Detects_task_and_budget_request_overdue()
    {
        var now = new DateTimeOffset(2026, 7, 17, 10, 0, 0, TimeSpan.Zero);
        var task = new TaskItem { Status = TaskStatus.Pending, DueUtc = now.AddMinutes(-5) };
        var request = new BudgetRequest { Status = BudgetRequestStatus.Requested, ExpectedDeadlineUtc = now.AddHours(-2) };

        Assert.True(DomainRules.IsTaskOverdue(task, now));
        Assert.True(DomainRules.IsBudgetRequestOverdue(request, now));
    }

    [Fact]
    public async Task Prevents_cyclic_work_item_dependencies()
    {
        var options = new DbContextOptionsBuilder<AppDbContext>()
            .UseInMemoryDatabase(Guid.NewGuid().ToString())
            .Options;
        await using var db = new AppDbContext(options);
        db.WorkItemDependencies.Add(new WorkItemDependency { WorkItemId = 1, DependsOnWorkItemId = 2 });
        db.WorkItemDependencies.Add(new WorkItemDependency { WorkItemId = 2, DependsOnWorkItemId = 3 });
        await db.SaveChangesAsync();

        Assert.True(await DomainRules.WouldCreateWorkItemCycle(db, 3, 1));
        Assert.False(await DomainRules.WouldCreateWorkItemCycle(db, 4, 1));
    }

    [Fact]
    public async Task Prevents_cyclic_task_hierarchy()
    {
        await using var db = NewDb();
        db.Tasks.Add(new TaskItem { Id = 1, ProjectId = 1, Title = "Épica" });
        db.Tasks.Add(new TaskItem { Id = 2, ProjectId = 1, Title = "Hija", ParentTaskId = 1 });
        db.Tasks.Add(new TaskItem { Id = 3, ProjectId = 1, Title = "Nieta", ParentTaskId = 2 });
        await db.SaveChangesAsync();

        Assert.True(await DomainRules.WouldCreateTaskHierarchyCycle(db, 1, 3));
        Assert.False(await DomainRules.WouldCreateTaskHierarchyCycle(db, 4, 1));
    }

    [Fact]
    public async Task Prevents_cyclic_task_dependencies()
    {
        await using var db = NewDb();
        db.TaskDependencies.Add(new TaskDependency { ProjectId = 1, PredecessorTaskId = 1, SuccessorTaskId = 2 });
        db.TaskDependencies.Add(new TaskDependency { ProjectId = 1, PredecessorTaskId = 2, SuccessorTaskId = 3 });
        await db.SaveChangesAsync();

        Assert.True(await DomainRules.WouldCreateTaskDependencyCycle(db, 3, 1));
        Assert.False(await DomainRules.WouldCreateTaskDependencyCycle(db, 1, 4));
    }

    [Fact]
    public async Task Validates_task_dates_and_progress()
    {
        await using var db = NewDb();

        Assert.NotNull(await DomainRules.ValidateTaskAsync(db, new TaskItem { ProjectId = 1, Title = "Mal", ProgressPercent = 101 }));
        Assert.NotNull(await DomainRules.ValidateTaskAsync(db, new TaskItem { ProjectId = 1, Title = "Mal", PlannedStartAt = DateTimeOffset.UtcNow, PlannedEndAt = DateTimeOffset.UtcNow.AddDays(-1) }));
        Assert.Null(await DomainRules.ValidateTaskAsync(db, new TaskItem { ProjectId = 1, Title = "Bien", ProgressPercent = 50, PlannedStartAt = DateTimeOffset.UtcNow, PlannedEndAt = DateTimeOffset.UtcNow.AddDays(1) }));
    }

    [Fact]
    public async Task Task_relations_returns_direct_issue()
    {
        await using var db = NewDb();
        var task = new TaskItem { Id = 1, ProjectId = 1, Title = "Tarea", IssueId = 7 };
        db.Tasks.Add(task);
        db.Issues.Add(new Issue { Id = 7, ProjectId = 1, Title = "Incidencia", DetectedAtUtc = DateTimeOffset.UtcNow });
        await db.SaveChangesAsync();

        var relations = await TaskRelationReader.BuildAsync(db, task);

        Assert.Single(relations.Issues);
        Assert.Equal("Incidencia", relations.Issues[0].Title);
    }

    [Fact]
    public async Task Task_relations_merges_multiple_and_deduplicates_generic_links()
    {
        await using var db = NewDb();
        var task = new TaskItem { Id = 1, ProjectId = 1, Title = "Tarea", IssueId = 7 };
        db.Tasks.Add(task);
        db.Issues.Add(new Issue { Id = 7, ProjectId = 1, Title = "Principal", DetectedAtUtc = DateTimeOffset.UtcNow });
        db.Issues.Add(new Issue { Id = 8, ProjectId = 1, Title = "Secundaria", DetectedAtUtc = DateTimeOffset.UtcNow });
        db.EntityLinks.Add(new EntityLink { ProjectId = 1, SourceType = "Task", SourceId = 1, TargetType = "Issue", TargetId = 7, Type = LinkType.RelatedTo });
        db.EntityLinks.Add(new EntityLink { ProjectId = 1, SourceType = "Task", SourceId = 1, TargetType = "Issue", TargetId = 8, Type = LinkType.RelatedTo });
        await db.SaveChangesAsync();

        var relations = await TaskRelationReader.BuildAsync(db, task);

        Assert.Equal(2, relations.Issues.Count);
        Assert.Contains(relations.Issues, issue => issue.Id == 7);
        Assert.Contains(relations.Issues, issue => issue.Id == 8);
    }

    [Fact]
    public async Task Task_relations_ignores_orphan_generic_issue_link()
    {
        await using var db = NewDb();
        var task = new TaskItem { Id = 1, ProjectId = 1, Title = "Tarea" };
        db.Tasks.Add(task);
        db.EntityLinks.Add(new EntityLink { ProjectId = 1, SourceType = "Task", SourceId = 1, TargetType = "Issue", TargetId = 99, Type = LinkType.RelatedTo });
        await db.SaveChangesAsync();

        var relations = await TaskRelationReader.BuildAsync(db, task);

        Assert.Empty(relations.Issues);
    }

    [Fact]
    public async Task Contact_relations_include_domain_references_without_entity_links()
    {
        await using var db = NewDb();
        db.Contacts.Add(new Contact { Id = 4, ProjectId = 1, Name = "Alfonso" });
        db.Contacts.Add(new Contact { Id = 5, ProjectId = 1, Name = "Libre" });
        db.BudgetRequests.Add(new BudgetRequest
        {
            ProjectId = 1,
            Title = "Presupuesto reforma general",
            WorkDescription = "Reforma",
            ProviderId = 4,
            RequestedAtUtc = DateTimeOffset.UtcNow,
            Status = BudgetRequestStatus.Requested
        });
        await db.SaveChangesAsync();

        Assert.True(await DomainRules.HasContactRelations(db, 4));
        Assert.False(await DomainRules.HasContactRelations(db, 5));
    }

    [Fact]
    public void Quote_line_calculates_tax_with_decimal_money()
    {
        var line = new QuoteLine { Quantity = 2, UnitPrice = 199.95m, TaxRate = 21 };
        line.Recalculate();

        Assert.Equal(83.98m, line.TaxAmount);
        Assert.Equal(483.88m, line.Total);
    }

    [Fact]
    public void Password_hash_roundtrip_uses_verification()
    {
        var hash = PasswordHasher.Hash("clave-larga");

        Assert.True(PasswordHasher.Verify("clave-larga", hash));
        Assert.False(PasswordHasher.Verify("otra", hash));
    }

    [Fact]
    public void Comparison_marks_missing_required_concepts()
    {
        var quote = new Quote
        {
            Reference = "A",
            Provider = new Contact { Name = "Proveedor" },
            Lines = [new QuoteLine { Concept = "Demolición", InclusionStatus = LineInclusionStatus.Included, Total = 100 }]
        };
        quote.Recalculate();
        var comparison = new QuoteComparison
        {
            Title = "Tabique",
            Concepts = [new ComparisonConcept { Name = "Demolición", Required = true }, new ComparisonConcept { Name = "Retirada de escombros", Required = true }],
            Entries = [new QuoteComparisonEntry { Quote = quote }]
        };

        var dto = ComparisonDto.From(comparison);
        var json = System.Text.Json.JsonSerializer.Serialize(dto);

        Assert.Contains("retirada de escombros", json);
        Assert.Contains("\"comparable\":false", json);
    }

    private static AppDbContext NewDb()
    {
        var options = new DbContextOptionsBuilder<AppDbContext>()
            .UseInMemoryDatabase(Guid.NewGuid().ToString())
            .Options;
        return new AppDbContext(options);
    }
}
