export type View =
  | 'dashboard'
  | 'project'
  | 'work'
  | 'contacts'
  | 'tasks'
  | 'calendar'
  | 'interventions'
  | 'quotes'
  | 'comparisons'
  | 'economy'
  | 'invoices'
  | 'documents'
  | 'alerts'
  | 'activity'
  | 'relationMigration';

export type User = { id: number; email: string; displayName: string };
export type Project = { id: number; name: string; description?: string; location?: string; status: number; targetBudget: number; contingencyFund: number; notes?: string; tags: string[] };
export type Dashboard = {
  project: Project;
  economy: Record<string, number>;
  overdueTasks: number;
  dueToday: number;
  overdueBudgetRequests: number;
  unpaidInvoices: number;
  upcoming: Appointment[];
  alerts: Alert[];
  timeline: Activity[];
};
export type Contact = { id: number; name: string; surname?: string; companyName?: string; displayName?: string; type?: number; trade: number; phone?: string; email?: string; status: number; notes?: string };
export type WorkItem = { id: number; title: string; description?: string; category: number; status: number; priority: number; targetCost: number; estimatedCost: number; dependsOn?: unknown[] };
export type TaskCategory = { id: number; projectId: number; name: string; color?: string; sortOrder: number };
export type TaskDependency = { id: number; projectId: number; predecessorTaskId: number; successorTaskId: number; dependencyType: number };
export type Task = { id: number; projectId: number; title: string; description?: string; status: number; priority: number; responsible?: string; dueUtc?: string; blockingReason?: string; contact?: Contact; primaryWorkItemId?: number; issueId?: number; taskType: number; timingKind: number; parentTaskId?: number; sortOrder: number; progressPercent: number; isPlanningProvisional: boolean; planningWarning?: string; plannedStartAt?: string; plannedEndAt?: string; actualStartAt?: string; actualEndAt?: string; categoryId?: number; category?: TaskCategory };
export type Communication = { id: number; occurredAtUtc: string; type: number; summary: string; detail?: string; result?: string; nextStep?: string; contact?: Contact };
export type Appointment = { id: number; title: string; startUtc: string; endUtc?: string; location?: string; participants?: string; status: number };
export type Intervention = { id: number; title: string; description?: string; status: number; plannedStartUtc?: string; expectedCost?: number; agreedCost?: number; provider?: Contact };
export type BudgetRequest = { id: number; title: string; workDescription: string; providerId: number; requestedAtUtc?: string; channel?: number; expectedDeadlineUtc?: string; status: number; requiresVisit?: boolean };
export type Quote = { id: number; reference: string; providerId: number; provider?: Contact; status: number; subtotal: number; discounts: number; taxes: number; total: number; issuedAtUtc?: string; receivedAtUtc?: string; validUntilUtc?: string; currency?: string; estimatedDuration?: string; paymentTerms?: string; warranty?: string; exclusions?: string; notes?: string; budgetRequestId?: number; lines: QuoteLine[] };
export type QuoteLine = { id: number; concept: string; description?: string; quantity: number; unit: string; unitPrice: number; taxRate: number; total: number; category: number; inclusionStatus: number; workItemId?: number; optional: boolean };
export type Comparison = { id: number; title: string; entries: Array<{ reference: string; provider?: string; total: number; normalizedTotal: number; comparable: boolean; missingRequired: string[] }> };
export type InvoiceRow = { invoice: Invoice; balance: { total: number; paid: number; pending: number; overdue: boolean } };
export type Invoice = { id: number; number: string; supplierId: number; supplier?: Contact; status: number; subtotal?: number; taxes?: number; total: number; issueDateUtc?: string; receivedAtUtc?: string; dueDateUtc?: string; quoteId?: number; notes?: string; lines?: InvoiceLine[]; payments?: Payment[] };
export type InvoiceLine = { id: number; concept: string; quantity: number; unitPrice: number; taxRate: number; total: number };
export type Payment = { id: number; invoiceId: number; paidAtUtc: string; amount: number; method: number; reference?: string; notes?: string };
export type DocumentRow = { id: number; title: string; type: number; originalFileName: string; mimeType: string; sizeBytes: number; uploadedAtUtc: string };
export type Alert = { id: number; title: string; description?: string; severity: number; dueUtc?: string; entityType: string; entityId: number };
export type Activity = { id: number; occurredAtUtc: string; entityType: string; entityId: number; action: string; summary: string };
export type Issue = { id: number; title: string; description?: string; severity: number; status: number; detectedAtUtc?: string; detectedByContactId?: number; knownCause?: string; proposedSolution?: string; appliedSolution?: string };
export type Requirement = { id: number; text: string; type: number; complianceStatus: number; justification?: string; communicatedToContactId?: number; communicatedAtUtc?: string };
export type Decision = { id: number; title: string; decisionText: string; decidedAtUtc?: string; reason?: string; alternatives?: string; economicImpact?: number };
export type EntityLink = { id: number; sourceType: string; sourceId: number; targetType: string; targetId: number; type: number; description?: string; createdAtUtc: string };
export type NoteReference = { id: number; noteId: number; targetEntityType: string; targetEntityId: number };
export type Note = { id: number; projectId: number; body: string; occurredAt: string; createdAt: string; updatedAt: string; authorUserId?: number; primaryWorkItemId?: number; primaryContactId?: number; isPinned: boolean; isDeleted: boolean; references: NoteReference[] };
export type ContextItem = { role: string; entityType: string; entityId: number; label: string; detail?: string; legacy: boolean };
export type EntityContext = { structured: ContextItem[]; legacy: ContextItem[] };
export type RelationMigrationItem = { entityLinkId: number; source: string; target: string; oldType: string; proposal: string; status: string };
export type TaskRelations = { issues: Issue[]; interventions: Intervention[]; budgetRequests: BudgetRequest[]; quotes: Quote[] };
export type SearchResults = { contacts: Contact[]; workItems: WorkItem[]; documents: DocumentRow[]; quotes: Quote[]; invoices: Invoice[] };

export const enumLabel = (items: string[], value: number) => items[value] ?? String(value);
export const projectStatuses = ['Planificación', 'En curso', 'Pausado', 'Finalizado', 'Cancelado'];
export const workStatuses = ['Planificada', 'En curso', 'Bloqueada', 'Terminada', 'Cancelada'];
export const priorities = ['Baja', 'Normal', 'Alta', 'Crítica'];
export const trades = ['Electricidad', 'Albañilería', 'Fontanería', 'Carpintería', 'Arquitectura', 'Pintura', 'Climatización', 'Ventanas', 'Cocina', 'Administración', 'Distribuidora eléctrica', 'Otros'];
export const contactTypes = ['Persona', 'Autónomo', 'Empresa', 'Administración', 'Comercializadora', 'Distribuidora', 'Proveedor', 'Otro'];
export const contactStatuses = ['Candidato', 'Contactado', 'Pendiente respuesta', 'Seleccionado', 'Contratado', 'Descartado', 'Finalizado'];
export const communicationTypes = ['Llamada realizada', 'Llamada recibida', 'Correo enviado', 'Correo recibido', 'Mensaje', 'Reunión', 'Visita', 'Presencial', 'Seguimiento'];
export const taskTypes = ['Tarea', 'Épica', 'Hito'];
export const taskTimingKinds = ['Trabajo', 'Espera', 'Hito'];
export const taskStatuses = ['Pendiente', 'En curso', 'Bloqueada', 'Completada', 'Cancelada'];
export const dependencyTypes = ['Fin a inicio', 'Inicio a inicio'];
export const appointmentStatuses = ['Propuesta', 'Confirmada', 'Realizada', 'Cancelada'];
export const interventionStatuses = ['Propuesta', 'Planificada', 'Confirmada', 'En curso', 'Terminada', 'Cancelada', 'Requiere revisión'];
export const budgetRequestStatuses = ['Borrador', 'Solicitada', 'Recibida', 'Vencida', 'Cancelada', 'Sin respuesta'];
export const quoteStatuses = ['Recibido', 'En revisión', 'Requiere aclaración', 'Aceptado', 'Rechazado', 'Vencido', 'Sustituido'];
export const invoiceStatuses = ['Recibida', 'Revisada', 'Parcialmente pagada', 'Pagada', 'Vencida', 'Anulada', 'En disputa'];
export const issueStatuses = ['Abierta', 'Investigando', 'Solución propuesta', 'Resuelta', 'Cancelada'];
export const severities = ['Baja', 'Media', 'Alta', 'Crítica'];
export const requirementTypes = ['Obligatorio', 'Preferido', 'Recomendado', 'Descartado'];
export const complianceStatuses = ['Pendiente', 'Comunicado', 'Aceptado', 'Cumplido', 'No cumplido', 'Descartado'];
export const paymentMethods = ['Transferencia', 'Tarjeta', 'Efectivo', 'Domiciliación', 'Otro'];
export const documentTypes = ['Plano', 'Presupuesto', 'Factura', 'Justificante de pago', 'Contrato', 'Licencia', 'Certificado', 'Boletín', 'Fotografía', 'Informe', 'Comunicación', 'Otro'];
export const entityTypes = ['Project', 'WorkItem', 'Contact', 'Communication', 'Task', 'Appointment', 'Intervention', 'Issue', 'Requirement', 'Decision', 'BudgetRequest', 'Quote', 'QuoteComparison', 'Invoice', 'Payment', 'Document'];
export const linkTypes = ['Depende de', 'Originado por', 'Resuelve', 'Sustituye a', 'Relacionado con', 'Justifica', 'Bloquea', 'Generó', 'Evidencia', 'Documento de', 'Presupuesto origen', 'Factura correspondiente'];
export const economyLabels: Record<string, string> = {
  targetBudget: 'Presupuesto objetivo',
  estimated: 'Estimado',
  committed: 'Comprometido',
  invoiced: 'Facturado',
  paid: 'Pagado',
  pendingToInvoice: 'Pendiente de facturar',
  pendingToPay: 'Pendiente de pago',
  forecastFinal: 'Previsión final',
  deviation: 'Desviación',
  deviationPercent: 'Desviación porcentual',
  contingencyRemaining: 'Contingencia disponible'
};
