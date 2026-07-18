import React, { useDeferredValue, useEffect, useMemo, useState, useTransition } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ArrowRight,
  Banknote,
  Bell,
  BriefcaseBusiness,
  CalendarDays,
  ClipboardCheck,
  Clock,
  FileText,
  FolderKanban,
  Hammer,
  Home,
  Info,
  Landmark,
  Link2,
  MessageSquare,
  Plus,
  Receipt,
  Search,
  Upload,
  Users,
  X
} from 'lucide-react';
import { api, dateOnly, dateTime, euro } from './api/client';
import { entityLabel, localDateTimeValue, matchesSearch, numberValue, toUtc, useApi } from './appUtils';
import { Agenda, AlertList, ApiState, CardGrid, DataTable, Detail, Drawer, EmptyState, ErrorBoundary, Field, KpiGrid, MiniList, PageHeader, Panel, PrimaryAction, StatusBadge, StatusSummary, SubmitBar, Tabs, Timeline } from './components/ui';
import type {
  Activity,
  Alert,
  Appointment,
  BudgetRequest,
  Communication,
  Comparison,
  Contact,
  Dashboard,
  Decision,
  DocumentRow,
  EntityContext,
  EntityLink,
  Intervention,
  InvoiceRow,
  Issue,
  Note,
  Payment,
  Project,
  Quote,
  RelationMigrationItem,
  Requirement,
  SearchResults,
  Task,
  TaskCategory,
  TaskRelations,
  User,
  View,
  WorkItem
} from './domain';
import {
  appointmentStatuses,
  budgetRequestStatuses,
  communicationTypes,
  complianceStatuses,
  contactStatuses,
  contactTypes,
  documentTypes,
  economyLabels,
  entityTypes,
  enumLabel,
  interventionStatuses,
  invoiceStatuses,
  issueStatuses,
  linkTypes,
  paymentMethods,
  priorities,
  projectStatuses,
  quoteStatuses,
  requirementTypes,
  severities,
  taskStatuses,
  taskTimingKinds,
  taskTypes,
  trades,
  workStatuses
} from './domain';
import './styles/app.css';

const navGroups: Array<{ group: string; items: Array<{ view: View; label: string; icon: React.ElementType }> }> = [
  { group: 'Inicio', items: [{ view: 'dashboard', label: 'Dashboard', icon: Home }] },
  { group: 'Proyecto', items: [
    { view: 'project', label: 'Resumen', icon: FolderKanban },
    { view: 'work', label: 'Partidas', icon: Hammer },
    { view: 'documents', label: 'Documentos', icon: Upload }
  ] },
  { group: 'Operativa', items: [
    { view: 'tasks', label: 'Tareas', icon: ClipboardCheck },
    { view: 'calendar', label: 'Calendario', icon: CalendarDays },
    { view: 'interventions', label: 'Intervenciones', icon: BriefcaseBusiness },
    { view: 'alerts', label: 'Seguimiento', icon: Bell }
  ] },
  { group: 'Proveedores', items: [
    { view: 'contacts', label: 'Contactos', icon: Users },
    { view: 'quotes', label: 'Presupuestos', icon: FileText },
    { view: 'comparisons', label: 'Comparaciones', icon: Landmark }
  ] },
  { group: 'Finanzas', items: [
    { view: 'economy', label: 'Resumen económico', icon: Banknote },
    { view: 'invoices', label: 'Facturas y pagos', icon: Receipt }
  ] },
  { group: 'Historial', items: [
    { view: 'activity', label: 'Actividad global', icon: Clock },
    { view: 'relationMigration', label: 'Migración relaciones', icon: Link2 }
  ] }
];
const nav = navGroups.flatMap((group) => group.items);

function routeFromLocation(): { view: View; taskId: number | null; contactId: number | null; workItemId: number | null } {
  const path = window.location.pathname;
  const taskMatch = path.match(/^\/tasks\/(\d+)/);
  if (path.startsWith('/tasks')) return { view: 'tasks', taskId: taskMatch ? Number(taskMatch[1]) : null, contactId: null, workItemId: null };
  if (path.startsWith('/calendar')) return { view: 'calendar', taskId: null, contactId: null, workItemId: null };
  const simple: Record<string, View> = { '/': 'dashboard', '/project': 'project', '/work': 'work', '/contacts': 'contacts', '/quotes': 'quotes', '/comparisons': 'comparisons', '/economy': 'economy', '/invoices': 'invoices', '/documents': 'documents', '/alerts': 'alerts', '/activity': 'activity', '/relation-migration': 'relationMigration' };
  return { view: simple[path] || 'dashboard', taskId: null, contactId: null, workItemId: null };
}

function pushRoute(path: string) {
  if (window.location.pathname + window.location.search !== path) window.history.pushState({}, '', path);
}

function pathForView(view: View) {
  const paths: Record<View, string> = { dashboard: '/', project: '/project', work: '/work', contacts: '/contacts', tasks: '/tasks', calendar: '/calendar', interventions: '/interventions', quotes: '/quotes', comparisons: '/comparisons', economy: '/economy', invoices: '/invoices', documents: '/documents', alerts: '/alerts', activity: '/activity', relationMigration: '/relation-migration' };
  return paths[view];
}

function enumOptions(items: string[]) {
  return items.map((item, index) => <option key={item} value={index}>{item}</option>);
}

const entityTypeLabels: Record<string, string> = {
  Project: 'Proyecto',
  WorkItem: 'Partida',
  Contact: 'Contacto',
  Communication: 'Comunicación',
  Task: 'Tarea',
  Appointment: 'Cita',
  Intervention: 'Intervención',
  Issue: 'Incidencia',
  Requirement: 'Requisito',
  Decision: 'Decisión',
  BudgetRequest: 'Solicitud',
  Quote: 'Presupuesto',
  QuoteComparison: 'Comparación',
  Invoice: 'Factura',
  Payment: 'Pago',
  Document: 'Documento'
};

function otherSide(link: EntityLink, entityType: string, entityId: number) {
  return link.sourceType === entityType && link.sourceId === entityId
    ? { type: link.targetType, id: link.targetId }
    : { type: link.sourceType, id: link.sourceId };
}
function displayNoteBody(body: string) {
  return body.replaceAll('Relación legacy:', 'Relación anterior:').replaceAll(' legacy', '').replaceAll('Legacy:', 'Relación pendiente:');
}

function relationTouches(link: EntityLink, entityType: string, entityId: number) {
  return (link.sourceType === entityType && link.sourceId === entityId) || (link.targetType === entityType && link.targetId === entityId);
}

const relationTypeHints: Record<string, { definition: string; useWhen: string; example: string }> = {
  Project: { definition: 'El expediente general de la reforma.', useWhen: 'para vincular decisiones o documentos que afectan a todo el proyecto.', example: 'Licencia municipal del proyecto completo.' },
  WorkItem: { definition: 'Una zona o bloque de alcance: electricidad, baño, cocina, ventanas...', useWhen: 'para agrupar costes, tareas, presupuestos, incidencias o documentos por parte de la obra.', example: 'La incidencia bloquea la partida Electricidad.' },
  Contact: { definition: 'Una persona, empresa, proveedor, gremio o administración.', useWhen: 'cuando el vínculo depende de quién lo ejecuta, factura, comunica o resuelve.', example: 'La intervención la realiza el electricista.' },
  Communication: { definition: 'Una llamada, correo, reunión o mensaje registrado.', useWhen: 'si una conversación originó una tarea, solicitud, decisión o requisito.', example: 'La llamada generó una tarea de seguimiento.' },
  Task: { definition: 'Una acción pendiente o completada que alguien debe ejecutar.', useWhen: 'para convertir una incidencia, intervención, requisito o presupuesto en trabajo accionable.', example: 'Llamar para resolver la incidencia de boletín.' },
  Appointment: { definition: 'Una visita, cita o hito de calendario.', useWhen: 'si la relación depende de una fecha acordada.', example: 'Visita de medición de ventanas.' },
  Intervention: { definition: 'Un trabajo real planificado o ejecutado por un proveedor.', useWhen: 'para conectar tareas, incidencias, partidas, facturas o documentos con la actuación física.', example: 'Intervención de instalación del cuadro eléctrico.' },
  Issue: { definition: 'Un problema, bloqueo, defecto o riesgo que requiere seguimiento.', useWhen: 'cuando algo impide avanzar, exige corrección o genera tareas.', example: 'La distribuidora bloquea el alta hasta cambiar acometida.' },
  Requirement: { definition: 'Una condición que debe cumplirse.', useWhen: 'para obligaciones técnicas, normativas o preferencias comunicadas.', example: 'Debe quedar canalización preparada para futura inducción.' },
  Decision: { definition: 'Una elección tomada con motivo, alternativas o impacto.', useWhen: 'para dejar trazabilidad de por qué se eligió una opción.', example: 'Aceptar presupuesto B por plazo y garantía.' },
  BudgetRequest: { definition: 'Una solicitud enviada a un proveedor para recibir oferta.', useWhen: 'antes de tener un presupuesto formal.', example: 'Solicitud enviada a Manuel para derivación individual.' },
  Quote: { definition: 'Un presupuesto recibido con importes y líneas.', useWhen: 'para conectar oferta, partida, proveedor, comparación, factura o documento original.', example: 'Presupuesto recibido para ventanas.' },
  QuoteComparison: { definition: 'Una comparativa entre presupuestos.', useWhen: 'para justificar una decisión de proveedor.', example: 'Comparativa de tres ofertas de cocina.' },
  Invoice: { definition: 'Una factura recibida o pendiente de pago.', useWhen: 'para conectar gasto real con presupuesto, intervención, partida o documento.', example: 'Factura correspondiente a la intervención terminada.' },
  Payment: { definition: 'Un pago realizado contra una factura.', useWhen: 'para relacionar justificantes, facturas y estado de pago.', example: 'Transferencia del segundo pago.' },
  Document: { definition: 'Un archivo: plano, factura, foto, certificado, contrato o evidencia.', useWhen: 'cuando el archivo prueba, documenta o amplía otra entidad.', example: 'Foto que evidencia una incidencia resuelta.' }
};

const relationRules: Record<string, Array<{ targetType: string; linkType: number; reason: string }>> = {
  Task: [
    { targetType: 'Issue', linkType: 2, reason: 'la tarea resuelve, investiga o desbloquea una incidencia.' },
    { targetType: 'Intervention', linkType: 4, reason: 'la tarea prepara, coordina o revisa una intervención.' },
    { targetType: 'WorkItem', linkType: 4, reason: 'la tarea pertenece a una partida concreta.' },
    { targetType: 'Document', linkType: 8, reason: 'el documento sirve de evidencia o soporte de la tarea.' },
    { targetType: 'Contact', linkType: 4, reason: 'la tarea depende de una persona o proveedor.' }
  ],
  Issue: [
    { targetType: 'Task', linkType: 7, reason: 'la incidencia genera trabajo accionable.' },
    { targetType: 'Intervention', linkType: 6, reason: 'la incidencia bloquea o afecta a una intervención.' },
    { targetType: 'WorkItem', linkType: 6, reason: 'la incidencia bloquea una partida de la reforma.' },
    { targetType: 'Document', linkType: 8, reason: 'el documento demuestra el problema o su solución.' },
    { targetType: 'Contact', linkType: 1, reason: 'la incidencia fue comunicada u originada por un contacto.' }
  ],
  Intervention: [
    { targetType: 'Task', linkType: 7, reason: 'la intervención genera tareas de preparación, revisión o cierre.' },
    { targetType: 'Issue', linkType: 2, reason: 'la intervención resuelve o provoca una incidencia.' },
    { targetType: 'WorkItem', linkType: 4, reason: 'la intervención ejecuta una partida.' },
    { targetType: 'Document', linkType: 8, reason: 'el documento evidencia el trabajo realizado.' },
    { targetType: 'Invoice', linkType: 11, reason: 'la factura corresponde al trabajo ejecutado.' },
    { targetType: 'Contact', linkType: 4, reason: 'el contacto es proveedor o responsable de la intervención.' }
  ],
  WorkItem: [
    { targetType: 'Task', linkType: 7, reason: 'la partida genera tareas operativas.' },
    { targetType: 'Issue', linkType: 6, reason: 'la incidencia bloquea o afecta a la partida.' },
    { targetType: 'Intervention', linkType: 4, reason: 'la intervención ejecuta parte de la partida.' },
    { targetType: 'Quote', linkType: 10, reason: 'el presupuesto cubre esta partida.' },
    { targetType: 'Invoice', linkType: 11, reason: 'la factura corresponde a esta partida.' },
    { targetType: 'Document', linkType: 9, reason: 'el documento pertenece a esta partida.' }
  ],
  Contact: [
    { targetType: 'Task', linkType: 4, reason: 'hay trabajo pendiente con este contacto.' },
    { targetType: 'BudgetRequest', linkType: 7, reason: 'se le ha solicitado presupuesto.' },
    { targetType: 'Quote', linkType: 4, reason: 'el contacto es proveedor del presupuesto.' },
    { targetType: 'Intervention', linkType: 4, reason: 'el contacto ejecuta o coordina la intervención.' },
    { targetType: 'Invoice', linkType: 4, reason: 'el contacto emite o gestiona la factura.' },
    { targetType: 'Document', linkType: 9, reason: 'el documento pertenece al contacto.' }
  ],
  Quote: [
    { targetType: 'BudgetRequest', linkType: 1, reason: 'el presupuesto responde a una solicitud.' },
    { targetType: 'WorkItem', linkType: 10, reason: 'la oferta cubre una partida.' },
    { targetType: 'Contact', linkType: 4, reason: 'el contacto es proveedor.' },
    { targetType: 'Invoice', linkType: 11, reason: 'la factura viene de este presupuesto.' },
    { targetType: 'Document', linkType: 9, reason: 'el documento original es el presupuesto.' }
  ],
  Invoice: [
    { targetType: 'Quote', linkType: 10, reason: 'la factura procede de un presupuesto.' },
    { targetType: 'Intervention', linkType: 11, reason: 'la factura corresponde a una intervención.' },
    { targetType: 'WorkItem', linkType: 11, reason: 'el gasto pertenece a una partida.' },
    { targetType: 'Payment', linkType: 4, reason: 'el pago liquida total o parcialmente la factura.' },
    { targetType: 'Document', linkType: 9, reason: 'el archivo es la factura o justificante.' }
  ],
  Document: [
    { targetType: 'Issue', linkType: 8, reason: 'el archivo prueba una incidencia.' },
    { targetType: 'Intervention', linkType: 8, reason: 'el archivo evidencia una intervención.' },
    { targetType: 'Invoice', linkType: 9, reason: 'el archivo pertenece a una factura.' },
    { targetType: 'Quote', linkType: 9, reason: 'el archivo es un presupuesto original.' },
    { targetType: 'WorkItem', linkType: 9, reason: 'el archivo documenta una partida.' },
    { targetType: 'Contact', linkType: 9, reason: 'el archivo pertenece a un proveedor o administración.' }
  ],
  Requirement: [
    { targetType: 'Task', linkType: 7, reason: 'el requisito genera tareas para cumplirlo.' },
    { targetType: 'WorkItem', linkType: 4, reason: 'el requisito aplica a una partida.' },
    { targetType: 'Document', linkType: 8, reason: 'el documento acredita el cumplimiento.' },
    { targetType: 'Contact', linkType: 4, reason: 'el requisito se comunicó a un contacto.' }
  ],
  Decision: [
    { targetType: 'Quote', linkType: 5, reason: 'la decisión justifica aceptar o descartar una oferta.' },
    { targetType: 'WorkItem', linkType: 4, reason: 'la decisión afecta al alcance de una partida.' },
    { targetType: 'Task', linkType: 7, reason: 'la decisión genera trabajo pendiente.' },
    { targetType: 'Document', linkType: 8, reason: 'el documento justifica la decisión.' }
  ]
};
const advancedLinkTypeOptions = [4, 6, 3];
const advancedLinkType = (value: number) => advancedLinkTypeOptions.includes(value) ? value : 4;

function rulesForEntity(entityType: string) {
  return relationRules[entityType] || relationRules.WorkItem;
}

type GlobalSearchRow =
  | { kind: 'view'; type: 'Sección'; id: View; label: string; meta: string; icon: React.ElementType }
  | { kind: 'entity'; type: 'Contact' | 'WorkItem' | 'Document' | 'Quote' | 'Invoice'; id: number; label: string; meta: string; icon: React.ElementType };

function GlobalSearch({ onOpen, onNavigate }: { onOpen: (type: 'Contact' | 'WorkItem' | 'Document' | 'Quote' | 'Invoice', id: number) => void; onNavigate: (view: View) => void }) {
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [results, setResults] = useState<SearchResults | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const trimmed = deferredQuery.trim();
    if (trimmed.length < 2) { setResults(null); setError(''); setLoading(false); return; }
    let cancelled = false;
    const handle = window.setTimeout(() => {
      setLoading(true);
      setError('');
      api.get<SearchResults>(`/api/search?q=${encodeURIComponent(trimmed)}`)
        .then((value) => { if (!cancelled) setResults(value); })
        .catch((err) => { if (!cancelled) { setResults(null); setError(err instanceof Error ? err.message : 'No se pudo buscar'); } })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, 220);
    return () => { cancelled = true; window.clearTimeout(handle); };
  }, [deferredQuery]);
  const navRows: GlobalSearchRow[] = nav
    .filter((item) => matchesSearch(query, item.label, item.view, navGroups.find((group) => group.items.some((x) => x.view === item.view))?.group))
    .slice(0, 4)
    .map((item) => ({ kind: 'view', type: 'Sección', id: item.view, label: item.label, meta: `Abrir ${navGroups.find((group) => group.items.some((x) => x.view === item.view))?.group || 'sección'}`, icon: item.icon }));
  const entityRows: GlobalSearchRow[] = [
    ...(results?.contacts || []).map((x) => ({ kind: 'entity' as const, type: 'Contact' as const, id: x.id, label: x.displayName || x.name, meta: enumLabel(trades, x.trade), icon: Users })),
    ...(results?.workItems || []).map((x) => ({ kind: 'entity' as const, type: 'WorkItem' as const, id: x.id, label: x.title, meta: enumLabel(workStatuses, x.status), icon: Hammer })),
    ...(results?.documents || []).map((x) => ({ kind: 'entity' as const, type: 'Document' as const, id: x.id, label: x.title, meta: x.originalFileName, icon: Upload })),
    ...(results?.quotes || []).map((x) => ({ kind: 'entity' as const, type: 'Quote' as const, id: x.id, label: x.reference, meta: euro.format(x.total), icon: FileText })),
    ...(results?.invoices || []).map((x) => ({ kind: 'entity' as const, type: 'Invoice' as const, id: x.id, label: x.number, meta: euro.format(x.total), icon: Receipt }))
  ];
  const rows = [...navRows, ...entityRows].slice(0, 12);
  const showPanel = query.trim().length >= 2 && (loading || error || rows.length > 0 || results);
  const clear = () => { setQuery(''); setResults(null); setError(''); };
  const openRow = (row: GlobalSearchRow) => {
    if (row.kind === 'view') onNavigate(row.id);
    else onOpen(row.type, row.id);
    clear();
  };
  return <div className="global-search"><Search size={17} /><input placeholder="Buscar o ir a una sección..." value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') clear(); if (e.key === 'Enter' && rows[0]) openRow(rows[0]); }} />{query && <button className="search-clear" type="button" onClick={clear} aria-label="Limpiar búsqueda"><X size={14} /></button>}{showPanel && <div className="global-results">{loading && <span className="search-hint">Buscando...</span>}{error && <span className="search-hint error">{error}</span>}{!loading && !error && rows.length === 0 && <span className="search-hint">Sin resultados.</span>}{rows.map((row) => { const Icon = row.icon; return <button key={`${row.kind}:${row.type}:${row.id}`} onClick={() => openRow(row)}><span className="result-icon"><Icon size={15} /></span><span className="result-main"><b>{row.label}</b><small>{row.meta}</small></span><span className="result-type">{row.type}</span><ArrowRight size={14} /></button>; })}</div>}</div>;
}

function Login({ onLogin }: { onLogin: (user: User) => void }) {
  const [email, setEmail] = useState('admin@example.local');
  const [password, setPassword] = useState('change-this-password-before-use');
  const [error, setError] = useState('');
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    try {
      onLogin(await api.post<User>('/api/auth/login', { email, password }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo autenticar');
    }
  };
  return (
    <main className="login-shell">
      <form className="login-card" onSubmit={submit}>
        <img className="login-logo" src="/comops-logo.png" alt="COMOPS" />
        <h1>COMOPS</h1>
        <p>Construction Management Operations: tareas, gremios, presupuestos, documentos y cronología bajo control operativo.</p>
        <label>Correo<input value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label>Contraseña<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        {error && <span className="form-error">{error}</span>}
        <button className="primary">Entrar</button>
        <small>En producción cambia estas credenciales mediante `.env` antes del primer arranque.</small>
      </form>
    </main>
  );
}

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const initialRoute = routeFromLocation();
  const [view, setView] = useState<View>(initialRoute.view);
  const [selectedContactId, setSelectedContactId] = useState<number | null>(initialRoute.contactId);
  const [selectedWorkItemId, setSelectedWorkItemId] = useState<number | null>(initialRoute.workItemId);
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(initialRoute.taskId);
  const [isPending, startTransition] = useTransition();
  useEffect(() => {
    api.get<User>('/api/auth/me').then(setUser).catch(() => undefined).finally(() => setAuthChecked(true));
  }, []);
  useEffect(() => {
    const onPop = () => {
      const route = routeFromLocation();
      setView(route.view);
      setSelectedTaskId(route.taskId);
      if (route.contactId !== null) setSelectedContactId(route.contactId);
      if (route.workItemId !== null) setSelectedWorkItemId(route.workItemId);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  if (!authChecked) return <div className="loading">Cargando...</div>;
  if (!user) return <Login onLogin={setUser} />;
  const logout = async () => { await api.logout(); setUser(null); };
  const openEntity = (target: string, id: number) => {
    if (target === 'Contact') setSelectedContactId(id);
    if (target === 'WorkItem') setSelectedWorkItemId(id);
    if (target === 'Task') setSelectedTaskId(id);
    const route: Record<string, View> = {
      Project: 'project',
      WorkItem: 'work',
      Contact: 'contacts',
      Communication: 'contacts',
      Task: 'tasks',
      Appointment: 'calendar',
      Intervention: 'interventions',
      Issue: 'alerts',
      Requirement: 'alerts',
      Decision: 'alerts',
      BudgetRequest: 'quotes',
      Quote: 'quotes',
      QuoteComparison: 'comparisons',
      Invoice: 'invoices',
      Payment: 'invoices',
      Document: 'documents',
      Note: 'activity',
      EntityLink: 'activity'
    };
    const next = route[target] || 'activity';
    if (target === 'Task') pushRoute(`/tasks/${id}`);
    else pushRoute(pathForView(next));
    startTransition(() => setView(next));
  };
  const navigateView = (target: View) => { pushRoute(pathForView(target)); startTransition(() => setView(target)); };
  const activeGroup = navGroups.find((group) => group.items.some((item) => item.view === view));
  const activeItem = nav.find((item) => item.view === view);
  const ActiveIcon = activeItem?.icon || Home;
  return (
    <main className="app">
      <aside className="sidebar">
        <div className="brand"><img src="/comops-logo.png" alt="" /><div><span>COMOPS</span><small>Construction Management Operations</small></div></div>
        <nav>
          {navGroups.map((group) => <div className="nav-group" key={group.group}><span>{group.group}</span>{group.items.map(({ view: target, label, icon: Icon }) => (
            <button key={target} className={view === target ? 'active' : ''} onClick={() => navigateView(target)} aria-current={view === target ? 'page' : undefined}>
              <Icon size={18} /><span>{label}</span>
            </button>
          ))}</div>)}
        </nav>
      </aside>
      <section className={`main${isPending ? ' is-pending' : ''}`}>
        <header className="topbar">
          <div className="topbar-title">
            <span className="view-kicker"><ActiveIcon size={15} />{activeGroup?.group}</span>
            <h1>{activeItem?.label}</h1>
            <p>Europe/Madrid · EUR · PostgreSQL persistente</p>
          </div>
          <GlobalSearch onOpen={openEntity} onNavigate={navigateView} />
          <div className="userbox">
            <span>{user.displayName}</span>
            <button onClick={logout}>Salir</button>
          </div>
        </header>
        <ViewRouter view={view} selectedContactId={selectedContactId} onSelectContact={setSelectedContactId} selectedWorkItemId={selectedWorkItemId} onSelectWorkItem={setSelectedWorkItemId} selectedTaskId={selectedTaskId} onSelectTask={setSelectedTaskId} onOpenEntity={openEntity} onNavigateView={navigateView} />
      </section>
    </main>
  );
}

function ViewRouter({ view, selectedContactId, onSelectContact, selectedWorkItemId, onSelectWorkItem, selectedTaskId, onSelectTask, onOpenEntity, onNavigateView }: { view: View; selectedContactId: number | null; onSelectContact: (id: number | null) => void; selectedWorkItemId: number | null; onSelectWorkItem: (id: number | null) => void; selectedTaskId: number | null; onSelectTask: (id: number | null) => void; onOpenEntity: (type: string, id: number) => void; onNavigateView: (view: View) => void }) {
  const dashboard = useApi<Dashboard>('/api/dashboard', [view === 'dashboard']);
  const projectId = dashboard.data?.project.id ?? 1;
  if (view === 'dashboard') return <DashboardPage state={dashboard} onOpenEntity={onOpenEntity} onNavigateView={onNavigateView} />;
  if (view === 'project') return <ProjectPage projectId={projectId} />;
  if (view === 'work') return <WorkItemsPage projectId={projectId} selectedId={selectedWorkItemId} onSelect={onSelectWorkItem} onOpenEntity={onOpenEntity} />;
  if (view === 'contacts') return <ContactsPage projectId={projectId} selectedId={selectedContactId} onSelect={onSelectContact} onOpenEntity={onOpenEntity} />;
  if (view === 'tasks') return <TasksPage projectId={projectId} selectedId={selectedTaskId} onSelect={onSelectTask} onOpenEntity={onOpenEntity} />;
  if (view === 'calendar') return <CalendarPage projectId={projectId} />;
  if (view === 'interventions') return <InterventionsPage projectId={projectId} onOpenEntity={onOpenEntity} />;
  if (view === 'quotes') return <QuotesPage projectId={projectId} />;
  if (view === 'comparisons') return <ComparisonsPage projectId={projectId} />;
  if (view === 'economy') return <EconomyPage />;
  if (view === 'invoices') return <InvoicesPage projectId={projectId} />;
  if (view === 'documents') return <DocumentsPage projectId={projectId} />;
  if (view === 'alerts') return <AlertsPage projectId={projectId} onOpenEntity={onOpenEntity} />;
  if (view === 'relationMigration') return <RelationMigrationPage projectId={projectId} />;
  return <ActivityPage projectId={projectId} />;
}

function DashboardPage({ state, onOpenEntity, onNavigateView }: { state: ReturnType<typeof useApi<Dashboard>>; onOpenEntity: (type: string, id: number) => void; onNavigateView: (view: View) => void }) {
  if (state.loading || state.error || !state.data) return <div className="page-grid"><ApiState loading={state.loading} error={state.error || (!state.data ? 'Sin datos de dashboard.' : '')} /></div>;
  const d = state.data;
  const isEmptyProject = d.project.name === 'Proyecto sin configurar' && !d.project.description && !d.timeline.length && !d.alerts.length && !d.upcoming.length && d.economy.targetBudget === 0 && d.economy.estimated === 0 && d.economy.committed === 0 && d.economy.invoiced === 0;
  return (
    <div className="page-grid">
      <section className="hero-panel">
        <div>
          <span>Proyecto activo</span>
          <h2>{d.project.name}</h2>
          <p>{d.project.description}</p>
        </div>
        <StatusBadge>{enumLabel(projectStatuses, d.project.status)}</StatusBadge>
      </section>
      {isEmptyProject && <section className="onboarding-panel"><div><span>Primer uso</span><h2>Configura la reforma desde datos reales</h2><p>La base esta limpia. Empieza por el proyecto, añade partidas de alcance, contactos reales y documentos iniciales.</p></div><div className="onboarding-actions"><button onClick={() => onNavigateView('project')}>Configurar proyecto</button><button onClick={() => onNavigateView('work')}>Crear primera partida</button><button onClick={() => onNavigateView('contacts')}>Añadir proveedor</button><button onClick={() => onNavigateView('documents')}>Subir documento</button></div></section>}
      <KpiGrid items={[
        ['Presupuesto objetivo', euro.format(d.economy.targetBudget || 0)],
        ['Estimado partidas', euro.format(d.economy.estimated || 0)],
        ['Comprometido', euro.format(d.economy.committed || 0)],
        ['Facturado', euro.format(d.economy.invoiced || 0)],
        ['Pagado', euro.format(d.economy.paid || 0)],
        ['Pendiente pago', euro.format(d.economy.pendingToPay || 0)],
        ['Previsión final', euro.format(d.economy.forecastFinal || 0)],
        [Number(d.economy.deviation || 0) <= 0 ? 'Margen disponible' : 'Desviación sobre objetivo', euro.format(Math.abs(d.economy.deviation || 0))]
      ]} />
      <section className="panel split">
        <div>
          <h2>Alertas críticas</h2>
          <AlertList alerts={d.alerts} onOpenEntity={onOpenEntity} />
        </div>
        <div>
          <h2>Resumen operativo</h2>
          <div className="metric-list">
            <span><b>{d.overdueTasks}</b> tareas vencidas</span>
            <span><b>{d.dueToday}</b> vencen hoy</span>
            <span><b>{d.overdueBudgetRequests}</b> solicitudes sin respuesta</span>
            <span><b>{d.unpaidInvoices}</b> facturas con saldo</span>
          </div>
        </div>
      </section>
      <section className="panel split">
        <div>
          <h2>Próximas citas</h2>
          <Agenda items={d.upcoming} />
        </div>
        <div>
          <h2>Actividad reciente</h2>
          <Timeline items={d.timeline} />
        </div>
      </section>
    </div>
  );
}

function ProjectPage({ projectId }: { projectId: number }) {
  const { data, reload } = useApi<Project>(`/api/projects/${projectId}`, [projectId]);
  const [drawer, setDrawer] = useState(false);
  const [draft, setDraft] = useState({ name: '', description: '', location: '', status: 0, targetBudget: '0', contingencyFund: '0', tags: '', notes: '' });
  const [error, setError] = useState('');
  useEffect(() => {
    if (!data) return;
    setDraft({ name: data.name, description: data.description || '', location: data.location || '', status: data.status, targetBudget: String(data.targetBudget || 0), contingencyFund: String(data.contingencyFund || 0), tags: data.tags?.join(', ') || '', notes: data.notes || '' });
  }, [data]);
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    try {
      await api.put(`/api/projects/${projectId}`, { name: draft.name, description: draft.description, location: draft.location, status: Number(draft.status), targetBudget: numberValue(draft.targetBudget), contingencyFund: numberValue(draft.contingencyFund), notes: draft.notes, tags: draft.tags.split(',').map((x) => x.trim()).filter(Boolean) });
      setDrawer(false);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo guardar el proyecto');
    }
  };
  if (!data) return <Panel>Cargando proyecto...</Panel>;
  return <div className="page-grid"><PageHeader title="Resumen del proyecto" summary="Datos base editables: nombre, ubicación, estado, presupuesto y notas operativas." action={<PrimaryAction onClick={() => setDrawer(true)}>Editar proyecto</PrimaryAction>} /><Panel><Detail title={data.name} rows={[['Estado', enumLabel(projectStatuses, data.status)], ['Ubicación', data.location || '-'], ['Objetivo', euro.format(data.targetBudget)], ['Contingencia', euro.format(data.contingencyFund)], ['Etiquetas', data.tags?.join(', ') || '-']]} description={data.description || 'Proyecto pendiente de configurar.'} />{data.notes && <p className="note">{data.notes}</p>}</Panel><Drawer title="Editar proyecto" open={drawer} onClose={() => setDrawer(false)}><form className="form-grid drawer-form" onSubmit={save}><Field label="Nombre"><input required value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field><Field label="Ubicación"><input value={draft.location} onChange={(e) => setDraft({ ...draft, location: e.target.value })} /></Field><Field label="Estado"><select value={draft.status} onChange={(e) => setDraft({ ...draft, status: Number(e.target.value) })}>{enumOptions(projectStatuses)}</select></Field><Field label="Presupuesto objetivo"><input type="number" step="0.01" value={draft.targetBudget} onChange={(e) => setDraft({ ...draft, targetBudget: e.target.value })} /></Field><Field label="Contingencia"><input type="number" step="0.01" value={draft.contingencyFund} onChange={(e) => setDraft({ ...draft, contingencyFund: e.target.value })} /></Field><Field label="Etiquetas"><input value={draft.tags} onChange={(e) => setDraft({ ...draft, tags: e.target.value })} placeholder="reforma, vivienda, electricidad" /></Field><Field label="Descripción"><textarea value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></Field><Field label="Notas internas"><textarea value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} /></Field><SubmitBar error={error}><button className="primary">Guardar proyecto</button><button type="button" onClick={() => setDrawer(false)}>Cancelar</button></SubmitBar></form></Drawer></div>;
}

function ContactsPage({ projectId, selectedId, onSelect, onOpenEntity }: { projectId: number; selectedId: number | null; onSelect: (id: number | null) => void; onOpenEntity: (type: string, id: number) => void }) {
  const { data, reload } = useApi<Contact[]>(`/api/contacts?projectId=${projectId}`, [projectId]);
  const communications = useApi<Communication[]>(`/api/communications?projectId=${projectId}`, [projectId]);
  const tasks = useApi<Task[]>(`/api/tasks?projectId=${projectId}`, [projectId]);
  const requests = useApi<BudgetRequest[]>(`/api/budget-requests?projectId=${projectId}`, [projectId]);
  const quotes = useApi<Quote[]>(`/api/quotes?projectId=${projectId}`, [projectId]);
  const interventions = useApi<Intervention[]>(`/api/interventions?projectId=${projectId}`, [projectId]);
  const invoices = useApi<InvoiceRow[]>(`/api/invoices?projectId=${projectId}`, [projectId]);
  const detail = useApi<{ contact: Contact; stats: Record<string, number> }>(selectedId ? `/api/contacts/${selectedId}` : '/api/contacts/0', [selectedId]);
  const [filters, setFilters] = useState({ q: '', trade: '', status: '' });
  const [drawer, setDrawer] = useState<'new' | 'edit' | 'communication' | 'task' | 'budget' | 'visit' | 'intervention' | null>(null);
  const [editingContactId, setEditingContactId] = useState<number | null>(null);
  const [tab, setTab] = useState<'summary' | 'communications' | 'tasks' | 'quotes' | 'work' | 'activity'>('summary');
  const [draft, setDraft] = useState({ name: '', surname: '', companyName: '', type: 1, trade: 0, phone: '', email: '', status: 0, notes: '' });
  const [comm, setComm] = useState({ type: 0, summary: '', detail: '', result: '', nextStep: '', followUp: true, followUpTitle: '', followUpDue: '' });
  const [taskDraft, setTaskDraft] = useState({ title: '', description: '', priority: 1, due: '', responsible: '' });
  const [budgetDraft, setBudgetDraft] = useState({ title: '', workDescription: '', expectedDeadline: '', requiresVisit: true, followUp: true });
  const [visitDraft, setVisitDraft] = useState({ title: '', start: localDateTimeValue(), end: '', location: '', description: '' });
  const [interventionDraft, setInterventionDraft] = useState({ title: '', description: '', status: 0, plannedStart: '', expectedCost: '0', agreedCost: '0' });
  const [error, setError] = useState('');
  const selected = detail.data?.contact || (data || []).find((c) => c.id === selectedId) || null;
  const filtered = (data || []).filter((c) => matchesSearch(filters.q, c.displayName, c.name, c.surname, c.companyName, c.phone, c.email, enumLabel(trades, c.trade), enumLabel(contactStatuses, c.status)) && (!filters.trade || c.trade === Number(filters.trade)) && (!filters.status || c.status === Number(filters.status)));
  const selectedName = selected?.displayName || selected?.name || '';
  const relatedCommunications = (communications.data || []).filter((x) => x.contact?.id === selectedId);
  const relatedTasks = (tasks.data || []).filter((x) => x.contact?.id === selectedId);
  const relatedRequests = (requests.data || []).filter((x) => x.providerId === selectedId);
  const relatedQuotes = (quotes.data || []).filter((x) => x.provider?.id === selectedId);
  const relatedInterventions = (interventions.data || []).filter((x) => x.provider?.id === selectedId);
  const relatedInvoices = (invoices.data || []).filter((x) => x.invoice.supplier?.id === selectedId);
  const openNewContact = () => {
    setEditingContactId(null);
    setDraft({ name: '', surname: '', companyName: '', type: 1, trade: 0, phone: '', email: '', status: 0, notes: '' });
    setDrawer('new');
  };
  const openEdit = (c: Contact) => {
    setEditingContactId(c.id);
    setDraft({ name: c.name, surname: c.surname || '', companyName: c.companyName || '', type: c.type ?? 1, trade: c.trade, phone: c.phone || '', email: c.email || '', status: c.status, notes: c.notes || '' });
    onSelect(c.id);
    setDrawer('edit');
  };
  const saveContact = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    try {
      if (drawer === 'edit') {
        if (!editingContactId) throw new Error('No se puede guardar la edición porque no hay un contacto seleccionado.');
        await api.put(`/api/contacts/${editingContactId}`, { projectId, ...draft, type: Number(draft.type), trade: Number(draft.trade), status: Number(draft.status) });
        onSelect(editingContactId);
      } else if (drawer === 'new') {
        const created = await api.post<Contact>('/api/contacts', { projectId, ...draft, type: Number(draft.type), trade: Number(draft.trade), status: Number(draft.status) });
        onSelect(created.id);
      } else throw new Error('Acción de contacto no válida.');
      setDrawer(null);
      setEditingContactId(null);
      setDraft({ name: '', surname: '', companyName: '', type: 1, trade: 0, phone: '', email: '', status: 0, notes: '' });
      await reload();
      await detail.reload();
    } catch (err) { setError(err instanceof Error ? err.message : 'No se pudo guardar el contacto'); }
  };
  const createCommunication = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    await api.post('/api/communications', { projectId, occurredAtUtc: new Date().toISOString(), contactId: selected.id, type: Number(comm.type), summary: comm.summary, detail: comm.detail, result: comm.result, nextStep: comm.nextStep, workItemIds: [], createFollowUpTask: comm.followUp, followUpTitle: comm.followUpTitle || null, followUpDueUtc: toUtc(comm.followUpDue) });
    setComm({ type: 0, summary: '', detail: '', result: '', nextStep: '', followUp: true, followUpTitle: '', followUpDue: '' });
    setDrawer(null);
    await communications.reload();
    await tasks.reload();
  };
  const createTask = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    await api.post('/api/tasks', { projectId, title: taskDraft.title, description: taskDraft.description, status: 0, priority: Number(taskDraft.priority), responsible: taskDraft.responsible, dueUtc: toUtc(taskDraft.due), contactId: selected.id, blockingReason: null });
    setTaskDraft({ title: '', description: '', priority: 1, due: '', responsible: '' });
    setDrawer(null);
    await tasks.reload();
  };
  const createBudget = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    await api.post('/api/budget-requests', { projectId, title: budgetDraft.title, workDescription: budgetDraft.workDescription, providerId: selected.id, requestedAtUtc: new Date().toISOString(), channel: 0, expectedDeadlineUtc: toUtc(budgetDraft.expectedDeadline), status: 1, requiresVisit: budgetDraft.requiresVisit });
    if (budgetDraft.followUp) await api.post('/api/tasks', { projectId, title: `Seguimiento presupuesto: ${budgetDraft.title}`, description: budgetDraft.workDescription, status: 0, priority: 2, responsible: '', dueUtc: toUtc(budgetDraft.expectedDeadline), contactId: selected.id, blockingReason: null });
    setBudgetDraft({ title: '', workDescription: '', expectedDeadline: '', requiresVisit: true, followUp: true });
    setDrawer(null);
    await requests.reload();
    await tasks.reload();
  };
  const createVisit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    await api.post('/api/appointments', { projectId, title: visitDraft.title, startUtc: toUtc(visitDraft.start), endUtc: toUtc(visitDraft.end), location: visitDraft.location, participants: selectedName, description: visitDraft.description, status: 0 });
    setVisitDraft({ title: '', start: localDateTimeValue(), end: '', location: '', description: '' });
    setDrawer(null);
  };
  const createIntervention = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    await api.post('/api/interventions', { projectId, title: interventionDraft.title, description: interventionDraft.description, providerId: selected.id, status: Number(interventionDraft.status), plannedStartUtc: toUtc(interventionDraft.plannedStart), expectedCost: numberValue(interventionDraft.expectedCost), agreedCost: numberValue(interventionDraft.agreedCost) });
    setInterventionDraft({ title: '', description: '', status: 0, plannedStart: '', expectedCost: '0', agreedCost: '0' });
    setDrawer(null);
    await interventions.reload();
  };
  const remove = async (c: Contact) => {
    if (!window.confirm(`Eliminar contacto "${c.displayName || c.name}"? Si tiene actividad el backend lo impedirá.`)) return;
    await api.delete(`/api/contacts/${c.id}`);
    if (selectedId === c.id) onSelect(null);
    await reload();
  };
  const counts = contactStatuses.map((label, status) => [label, (data || []).filter((c) => c.status === status).length] as [string, number]).filter(([, count]) => count > 0);
  return <div className="page-grid"><PageHeader title="Contactos" summary="Directorio operativo de proveedores, gremios y administraciones." action={<PrimaryAction onClick={openNewContact}>Nuevo contacto</PrimaryAction>} /><StatusSummary items={counts} /><Panel title="Directorio"><div className="filter-bar"><input placeholder="Buscar nombre, empresa, teléfono o correo..." value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value })} /><select value={filters.trade} onChange={(e) => setFilters({ ...filters, trade: e.target.value })}><option value="">Todos los gremios</option>{enumOptions(trades)}</select><select value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}><option value="">Todos los estados</option>{enumOptions(contactStatuses)}</select></div>{filtered.length ? <DataTable headers={['Nombre', 'Gremio', 'Estado', 'Teléfono', 'Correo', 'Acciones']} rows={filtered.map((c) => [<button className="link-button" onClick={() => onSelect(c.id)}>{c.displayName || c.name}</button>, enumLabel(trades, c.trade), <StatusBadge>{enumLabel(contactStatuses, c.status)}</StatusBadge>, c.phone || '-', c.email || '-', <div className="inline-actions"><button onClick={() => onSelect(c.id)}>Abrir ficha</button><button onClick={() => openEdit(c)}>Editar</button><button className="danger ghost-danger" onClick={() => remove(c)}>Eliminar</button></div>])} /> : <EmptyState title="No hay contactos con esos filtros." />}</Panel>{selected && <Panel><div className="entity-header"><div><span>{enumLabel(trades, selected.trade)}</span><h2>{selectedName}</h2><p>{selected.companyName || enumLabel(contactTypes, selected.type ?? 0)}</p></div><StatusBadge>{enumLabel(contactStatuses, selected.status)}</StatusBadge></div><div className="quick-actions"><button onClick={() => setDrawer('communication')}>Registrar comunicación</button><button onClick={() => setDrawer('task')}>Crear tarea</button><button onClick={() => setDrawer('budget')}>Solicitar presupuesto</button><button onClick={() => setDrawer('visit')}>Programar visita</button><button onClick={() => setDrawer('intervention')}>Registrar intervención</button><button onClick={() => openEdit(selected)}>Editar contacto</button></div><Tabs tabs={[{ id: 'summary', label: 'Resumen' }, { id: 'communications', label: 'Comunicaciones' }, { id: 'tasks', label: 'Tareas' }, { id: 'quotes', label: 'Presupuestos' }, { id: 'work', label: 'Intervenciones y facturas' }, { id: 'activity', label: 'Actividad' }]} active={tab} onChange={setTab} />{tab === 'summary' && <div className="detail-grid"><Detail title="Datos de contacto" rows={[['Teléfono', selected.phone || '-'], ['Correo', selected.email || '-'], ['Estado', enumLabel(contactStatuses, selected.status)], ['Gremio', enumLabel(trades, selected.trade)]]} description={selected.notes || 'Sin observaciones.'} /><KpiGrid items={Object.entries(detail.data?.stats || {}).map(([k, v]) => [k, euro.format(v || 0)])} /><ContextNotebookPanel projectId={projectId} entityType="Contact" entityId={selected.id} entityName={selectedName} onOpenEntity={onOpenEntity} /></div>}{tab === 'communications' && <DataTable headers={['Fecha', 'Tipo', 'Resumen', 'Resultado']} rows={relatedCommunications.map((x) => [dateTime.format(new Date(x.occurredAtUtc)), enumLabel(communicationTypes, x.type), x.summary, x.result || '-'])} />}{tab === 'tasks' && <DataTable headers={['Tarea', 'Estado', 'Prioridad', 'Vence']} rows={relatedTasks.map((x) => [x.title, enumLabel(taskStatuses, x.status), enumLabel(priorities, x.priority), x.dueUtc ? dateTime.format(new Date(x.dueUtc)) : '-'])} />}{tab === 'quotes' && <><h3>Solicitudes</h3><DataTable headers={['Solicitud', 'Estado', 'Límite']} rows={relatedRequests.map((x) => [x.title, enumLabel(budgetRequestStatuses, x.status), x.expectedDeadlineUtc ? dateTime.format(new Date(x.expectedDeadlineUtc)) : '-'])} /><h3>Presupuestos</h3><DataTable headers={['Referencia', 'Estado', 'Total', 'Validez']} rows={relatedQuotes.map((x) => [x.reference, enumLabel(quoteStatuses, x.status), euro.format(x.total), x.validUntilUtc ? dateOnly.format(new Date(x.validUntilUtc)) : '-'])} /></>}{tab === 'work' && <><h3>Intervenciones</h3><DataTable headers={['Trabajo', 'Estado', 'Fecha', 'Acordado']} rows={relatedInterventions.map((x) => [x.title, enumLabel(interventionStatuses, x.status), x.plannedStartUtc ? dateTime.format(new Date(x.plannedStartUtc)) : '-', euro.format(x.agreedCost || 0)])} /><h3>Facturas</h3><DataTable headers={['Factura', 'Estado', 'Total', 'Pendiente']} rows={relatedInvoices.map((x) => [x.invoice.number, enumLabel(invoiceStatuses, x.invoice.status), euro.format(x.balance.total), euro.format(x.balance.pending)])} /></>}{tab === 'activity' && <Timeline items={[...relatedCommunications.map((x) => ({ id: x.id, occurredAtUtc: x.occurredAtUtc, entityType: 'Communication', entityId: x.id, action: enumLabel(communicationTypes, x.type), summary: x.summary })), ...relatedTasks.map((x) => ({ id: 10000 + x.id, occurredAtUtc: x.dueUtc || new Date().toISOString(), entityType: 'Task', entityId: x.id, action: 'Tarea vinculada', summary: x.title }))].sort((a, b) => new Date(b.occurredAtUtc).getTime() - new Date(a.occurredAtUtc).getTime())} />}</Panel>}{!selected && <EmptyState title="Selecciona un contacto para abrir su ficha operativa." />}<Drawer title={drawer === 'new' ? 'Nuevo contacto' : drawer === 'edit' ? 'Editar contacto' : `${selectedName} · ${drawer || ''}`} open={drawer !== null} onClose={() => { setDrawer(null); setEditingContactId(null); setError(''); }}>{(drawer === 'new' || drawer === 'edit') && <form className="form-grid drawer-form" onSubmit={saveContact}><Field label="Nombre"><input required value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field><Field label="Apellidos"><input value={draft.surname} onChange={(e) => setDraft({ ...draft, surname: e.target.value })} /></Field><Field label="Empresa"><input value={draft.companyName} onChange={(e) => setDraft({ ...draft, companyName: e.target.value })} /></Field><Field label="Tipo"><select value={draft.type} onChange={(e) => setDraft({ ...draft, type: Number(e.target.value) })}>{enumOptions(contactTypes)}</select></Field><Field label="Gremio"><select value={draft.trade} onChange={(e) => setDraft({ ...draft, trade: Number(e.target.value) })}>{enumOptions(trades)}</select></Field><Field label="Estado"><select value={draft.status} onChange={(e) => setDraft({ ...draft, status: Number(e.target.value) })}>{enumOptions(contactStatuses)}</select></Field><Field label="Teléfono"><input value={draft.phone} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} /></Field><Field label="Correo"><input value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} /></Field><Field label="Observaciones"><textarea value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} /></Field><SubmitBar error={error}><button className="primary">Guardar</button><button type="button" onClick={() => setDrawer(null)}>Cancelar</button></SubmitBar></form>}{drawer === 'communication' && <form className="form-grid drawer-form" onSubmit={createCommunication}><Field label="Tipo"><select value={comm.type} onChange={(e) => setComm({ ...comm, type: Number(e.target.value) })}>{enumOptions(communicationTypes)}</select></Field><Field label="Resumen"><input required value={comm.summary} onChange={(e) => setComm({ ...comm, summary: e.target.value })} /></Field><Field label="Detalle"><textarea value={comm.detail} onChange={(e) => setComm({ ...comm, detail: e.target.value })} /></Field><Field label="Resultado"><input value={comm.result} onChange={(e) => setComm({ ...comm, result: e.target.value })} /></Field><Field label="Próximo paso"><input value={comm.nextStep} onChange={(e) => setComm({ ...comm, nextStep: e.target.value })} /></Field><Field label="Seguimiento"><span className="check-row"><input type="checkbox" checked={comm.followUp} onChange={(e) => setComm({ ...comm, followUp: e.target.checked })} />Crear tarea</span></Field>{comm.followUp && <><Field label="Título tarea"><input value={comm.followUpTitle} onChange={(e) => setComm({ ...comm, followUpTitle: e.target.value })} /></Field><Field label="Vencimiento"><input type="datetime-local" value={comm.followUpDue} onChange={(e) => setComm({ ...comm, followUpDue: e.target.value })} /></Field></>}<SubmitBar><button className="primary">Registrar</button></SubmitBar></form>}{drawer === 'task' && <form className="form-grid drawer-form" onSubmit={createTask}><Field label="Título"><input required value={taskDraft.title} onChange={(e) => setTaskDraft({ ...taskDraft, title: e.target.value })} /></Field><Field label="Prioridad"><select value={taskDraft.priority} onChange={(e) => setTaskDraft({ ...taskDraft, priority: Number(e.target.value) })}>{enumOptions(priorities)}</select></Field><Field label="Responsable"><input value={taskDraft.responsible} onChange={(e) => setTaskDraft({ ...taskDraft, responsible: e.target.value })} /></Field><Field label="Vencimiento"><input type="datetime-local" value={taskDraft.due} onChange={(e) => setTaskDraft({ ...taskDraft, due: e.target.value })} /></Field><Field label="Descripción"><textarea value={taskDraft.description} onChange={(e) => setTaskDraft({ ...taskDraft, description: e.target.value })} /></Field><SubmitBar><button className="primary">Crear tarea</button></SubmitBar></form>}{drawer === 'budget' && <form className="form-grid drawer-form" onSubmit={createBudget}><Field label="Título"><input required value={budgetDraft.title} onChange={(e) => setBudgetDraft({ ...budgetDraft, title: e.target.value })} /></Field><Field label="Límite esperado"><input type="datetime-local" value={budgetDraft.expectedDeadline} onChange={(e) => setBudgetDraft({ ...budgetDraft, expectedDeadline: e.target.value })} /></Field><Field label="Visita previa"><span className="check-row"><input type="checkbox" checked={budgetDraft.requiresVisit} onChange={(e) => setBudgetDraft({ ...budgetDraft, requiresVisit: e.target.checked })} />Necesaria</span></Field><Field label="Seguimiento"><span className="check-row"><input type="checkbox" checked={budgetDraft.followUp} onChange={(e) => setBudgetDraft({ ...budgetDraft, followUp: e.target.checked })} />Crear tarea</span></Field><Field label="Trabajo solicitado"><textarea required value={budgetDraft.workDescription} onChange={(e) => setBudgetDraft({ ...budgetDraft, workDescription: e.target.value })} /></Field><SubmitBar><button className="primary">Solicitar presupuesto</button></SubmitBar></form>}{drawer === 'visit' && <form className="form-grid drawer-form" onSubmit={createVisit}><Field label="Título"><input required value={visitDraft.title} onChange={(e) => setVisitDraft({ ...visitDraft, title: e.target.value })} /></Field><Field label="Inicio"><input type="datetime-local" required value={visitDraft.start} onChange={(e) => setVisitDraft({ ...visitDraft, start: e.target.value })} /></Field><Field label="Fin"><input type="datetime-local" value={visitDraft.end} onChange={(e) => setVisitDraft({ ...visitDraft, end: e.target.value })} /></Field><Field label="Ubicación"><input value={visitDraft.location} onChange={(e) => setVisitDraft({ ...visitDraft, location: e.target.value })} /></Field><Field label="Descripción"><textarea value={visitDraft.description} onChange={(e) => setVisitDraft({ ...visitDraft, description: e.target.value })} /></Field><SubmitBar><button className="primary">Programar visita</button></SubmitBar></form>}{drawer === 'intervention' && <form className="form-grid drawer-form" onSubmit={createIntervention}><Field label="Trabajo"><input required value={interventionDraft.title} onChange={(e) => setInterventionDraft({ ...interventionDraft, title: e.target.value })} /></Field><Field label="Estado"><select value={interventionDraft.status} onChange={(e) => setInterventionDraft({ ...interventionDraft, status: Number(e.target.value) })}>{enumOptions(interventionStatuses)}</select></Field><Field label="Fecha prevista"><input type="datetime-local" value={interventionDraft.plannedStart} onChange={(e) => setInterventionDraft({ ...interventionDraft, plannedStart: e.target.value })} /></Field><Field label="Coste previsto"><input type="number" step="0.01" value={interventionDraft.expectedCost} onChange={(e) => setInterventionDraft({ ...interventionDraft, expectedCost: e.target.value })} /></Field><Field label="Coste acordado"><input type="number" step="0.01" value={interventionDraft.agreedCost} onChange={(e) => setInterventionDraft({ ...interventionDraft, agreedCost: e.target.value })} /></Field><Field label="Descripción"><textarea value={interventionDraft.description} onChange={(e) => setInterventionDraft({ ...interventionDraft, description: e.target.value })} /></Field><SubmitBar><button className="primary">Registrar intervención</button></SubmitBar></form>}</Drawer></div>;
}

function WorkItemsPage({ projectId, selectedId, onSelect, onOpenEntity }: { projectId: number; selectedId: number | null; onSelect: (id: number | null) => void; onOpenEntity: (type: string, id: number) => void }) {
  const { data, reload } = useApi<WorkItem[]>(`/api/work-items?projectId=${projectId}`, [projectId]);
  const contacts = useApi<Contact[]>(`/api/contacts?projectId=${projectId}`, [projectId]);
  const tasks = useApi<Task[]>(`/api/tasks?projectId=${projectId}`, [projectId]);
  const requests = useApi<BudgetRequest[]>(`/api/budget-requests?projectId=${projectId}`, [projectId]);
  const quotes = useApi<Quote[]>(`/api/quotes?projectId=${projectId}`, [projectId]);
  const interventions = useApi<Intervention[]>(`/api/interventions?projectId=${projectId}`, [projectId]);
  const issues = useApi<Issue[]>(`/api/issues?projectId=${projectId}`, [projectId]);
  const requirements = useApi<Requirement[]>(`/api/requirements?projectId=${projectId}`, [projectId]);
  const [filters, setFilters] = useState({ q: '', category: '', status: '' });
  const [drawer, setDrawer] = useState<'new' | 'edit' | 'task' | 'budget' | 'intervention' | 'issue' | 'requirement' | null>(null);
  const [editingWorkItemId, setEditingWorkItemId] = useState<number | null>(null);
  const [tab, setTab] = useState<'summary' | 'tasks' | 'quotes' | 'interventions' | 'followup'>('summary');
  const [draft, setDraft] = useState({ title: '', description: '', category: 0, status: 0, priority: 1, targetCost: '0', estimatedCost: '0', dependsOnWorkItemId: '' });
  const [taskDraft, setTaskDraft] = useState({ title: '', description: '', priority: 1, due: '', contactId: '' });
  const [budgetDraft, setBudgetDraft] = useState({ title: '', workDescription: '', providerId: '', expectedDeadline: '', requiresVisit: true });
  const [interventionDraft, setInterventionDraft] = useState({ title: '', description: '', providerId: '', status: 0, plannedStart: '', expectedCost: '0', agreedCost: '0' });
  const [issueDraft, setIssueDraft] = useState({ title: '', description: '', severity: 1, status: 0, contactId: '' });
  const [reqDraft, setReqDraft] = useState({ text: '', type: 1, justification: '', contactId: '', complianceStatus: 0 });
  const selected = (data || []).find((w) => w.id === selectedId) || null;
  const filtered = (data || []).filter((w) => matchesSearch(filters.q, w.title, w.description, enumLabel(trades, w.category), enumLabel(workStatuses, w.status)) && (!filters.category || w.category === Number(filters.category)) && (!filters.status || w.status === Number(filters.status)));
  const relatedTasks = (tasks.data || []).filter((x) => `${x.title} ${x.description || ''}`.toLowerCase().includes((selected?.title || '').toLowerCase()));
  const relatedQuotes = (quotes.data || []).filter((q) => (q.lines || []).some((l) => l.workItemId === selectedId));
  const relatedRequests = (requests.data || []).filter((r) => `${r.title} ${r.workDescription}`.toLowerCase().includes((selected?.title || '').toLowerCase()));
  const relatedInterventions = (interventions.data || []).filter((i) => `${i.title} ${i.description || ''}`.toLowerCase().includes((selected?.title || '').toLowerCase()));
  const quoteLinesTotal = relatedQuotes.flatMap((q) => q.lines || []).filter((l) => l.workItemId === selectedId).reduce((sum, line) => sum + line.total, 0);
  const openNewWorkItem = () => {
    setEditingWorkItemId(null);
    setDraft({ title: '', description: '', category: 0, status: 0, priority: 1, targetCost: '0', estimatedCost: '0', dependsOnWorkItemId: '' });
    setDrawer('new');
  };
  const openEdit = (w: WorkItem) => {
    setEditingWorkItemId(w.id);
    setDraft({ title: w.title, description: w.description || '', category: w.category, status: w.status, priority: w.priority, targetCost: String(w.targetCost), estimatedCost: String(w.estimatedCost), dependsOnWorkItemId: '' });
    onSelect(w.id);
    setDrawer('edit');
  };
  const saveWorkItem = async (event: React.FormEvent) => {
    event.preventDefault();
    const body = { projectId, title: draft.title, description: draft.description, category: Number(draft.category), status: Number(draft.status), priority: Number(draft.priority), targetCost: numberValue(draft.targetCost), estimatedCost: numberValue(draft.estimatedCost), dependsOnWorkItemId: draft.dependsOnWorkItemId ? Number(draft.dependsOnWorkItemId) : null };
    if (drawer === 'edit') {
      if (!editingWorkItemId) throw new Error('No se puede guardar la edición porque no hay una partida seleccionada.');
      await api.put(`/api/work-items/${editingWorkItemId}`, body);
      onSelect(editingWorkItemId);
    } else if (drawer === 'new') {
      const created = await api.post<WorkItem>('/api/work-items', body);
      onSelect(created.id);
    } else throw new Error('Acción de partida no válida.');
    setDrawer(null);
    setEditingWorkItemId(null);
    setDraft({ title: '', description: '', category: 0, status: 0, priority: 1, targetCost: '0', estimatedCost: '0', dependsOnWorkItemId: '' });
    await reload();
  };
  const setStatus = async (id: number, status: number) => { await api.patch(`/api/work-items/${id}/status`, { status }); await reload(); };
  const createTask = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    await api.post('/api/tasks', { projectId, title: taskDraft.title, description: `${taskDraft.description}\n\nPartida: ${selected.title}`.trim(), status: 0, priority: Number(taskDraft.priority), responsible: '', dueUtc: toUtc(taskDraft.due), contactId: taskDraft.contactId ? Number(taskDraft.contactId) : null, blockingReason: null });
    setTaskDraft({ title: '', description: '', priority: 1, due: '', contactId: '' });
    setDrawer(null);
    await tasks.reload();
  };
  const createBudget = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    await api.post('/api/budget-requests', { projectId, title: budgetDraft.title, workDescription: `${budgetDraft.workDescription}\n\nPartida: ${selected.title}`.trim(), providerId: Number(budgetDraft.providerId), requestedAtUtc: new Date().toISOString(), channel: 0, expectedDeadlineUtc: toUtc(budgetDraft.expectedDeadline), status: 1, requiresVisit: budgetDraft.requiresVisit });
    setBudgetDraft({ title: '', workDescription: '', providerId: '', expectedDeadline: '', requiresVisit: true });
    setDrawer(null);
    await requests.reload();
  };
  const createIntervention = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    await api.post('/api/interventions', { projectId, title: interventionDraft.title, description: `${interventionDraft.description}\n\nPartida: ${selected.title}`.trim(), providerId: interventionDraft.providerId ? Number(interventionDraft.providerId) : null, status: Number(interventionDraft.status), plannedStartUtc: toUtc(interventionDraft.plannedStart), expectedCost: numberValue(interventionDraft.expectedCost), agreedCost: numberValue(interventionDraft.agreedCost) });
    setInterventionDraft({ title: '', description: '', providerId: '', status: 0, plannedStart: '', expectedCost: '0', agreedCost: '0' });
    setDrawer(null);
    await interventions.reload();
  };
  const createIssue = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    await api.post('/api/issues', { projectId, title: issueDraft.title, description: `${issueDraft.description}\n\nPartida: ${selected.title}`.trim(), severity: Number(issueDraft.severity), status: Number(issueDraft.status), detectedAtUtc: new Date().toISOString(), detectedByContactId: issueDraft.contactId ? Number(issueDraft.contactId) : null, knownCause: null, proposedSolution: null, appliedSolution: null });
    setIssueDraft({ title: '', description: '', severity: 1, status: 0, contactId: '' });
    setDrawer(null);
    await issues.reload();
  };
  const createRequirement = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    await api.post('/api/requirements', { projectId, text: `${reqDraft.text}\nPartida: ${selected.title}`, type: Number(reqDraft.type), justification: reqDraft.justification, communicatedToContactId: reqDraft.contactId ? Number(reqDraft.contactId) : null, communicatedAtUtc: reqDraft.contactId ? new Date().toISOString() : null, complianceStatus: Number(reqDraft.complianceStatus) });
    setReqDraft({ text: '', type: 1, justification: '', contactId: '', complianceStatus: 0 });
    setDrawer(null);
    await requirements.reload();
  };
  const remove = async (w: WorkItem) => {
    if (!window.confirm(`Eliminar partida "${w.title}"? Si tiene relaciones el backend lo impedirá.`)) return;
    await api.delete(`/api/work-items/${w.id}`);
    if (selectedId === w.id) onSelect(null);
    await reload();
  };
  const totalsFor = (items: WorkItem[]) => {
    const target = items.reduce((sum, item) => sum + (item.targetCost || 0), 0);
    const estimated = items.reduce((sum, item) => sum + (item.estimatedCost || 0), 0);
    return { target, estimated, delta: estimated - target };
  };
  const allTotals = totalsFor(data || []);
  const filteredTotals = totalsFor(filtered);
  const hasFilter = Boolean(filters.q || filters.category || filters.status);
  const quoteLinesLinkedTotal = (quotes.data || []).flatMap((quote) => quote.lines || []).filter((line) => line.workItemId).reduce((sum, line) => sum + (line.total || 0), 0);
  const acceptedQuoteLinesTotal = (quotes.data || []).filter((quote) => quote.status === 3).flatMap((quote) => quote.lines || []).filter((line) => line.workItemId).reduce((sum, line) => sum + (line.total || 0), 0);
  const workKpis: Array<[string, string]> = [
    ['Partidas', String((data || []).length)],
    ['Objetivo total', euro.format(allTotals.target)],
    ['Estimado total', euro.format(allTotals.estimated)],
    [allTotals.delta <= 0 ? 'Margen estimado' : 'Sobrecoste estimado', euro.format(Math.abs(allTotals.delta))],
    ['Presupuestado vinculado', euro.format(quoteLinesLinkedTotal)],
    ['Aceptado en presupuestos', euro.format(acceptedQuoteLinesTotal)]
  ];
  if (hasFilter) {
    workKpis.push(['Partidas filtradas', String(filtered.length)]);
    workKpis.push(['Objetivo filtrado', euro.format(filteredTotals.target)]);
    workKpis.push(['Estimado filtrado', euro.format(filteredTotals.estimated)]);
  }
  const counts = workStatuses.map((label, status) => [label, (data || []).filter((w) => w.status === status).length] as [string, number]).filter(([, count]) => count > 0);
  return <div className="page-grid"><PageHeader title="Partidas" summary="Alcance técnico y económico del proyecto, con costes y bloqueos por gremio." action={<PrimaryAction onClick={openNewWorkItem}>Nueva partida</PrimaryAction>} /><StatusSummary items={counts} /><KpiGrid items={workKpis} /><Panel title="Mapa de partidas"><div className="filter-bar"><input placeholder="Buscar partida..." value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value })} /><select value={filters.category} onChange={(e) => setFilters({ ...filters, category: e.target.value })}><option value="">Todos los gremios</option>{enumOptions(trades)}</select><select value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}><option value="">Todos los estados</option>{enumOptions(workStatuses)}</select></div>{filtered.length ? <DataTable headers={['Partida', 'Gremio', 'Estado', 'Objetivo', 'Estimado', 'Acciones']} rows={[...filtered.map((w) => [<button className="link-button" onClick={() => onSelect(w.id)}>{w.title}</button>, enumLabel(trades, w.category), <StatusBadge>{enumLabel(workStatuses, w.status)}</StatusBadge>, euro.format(w.targetCost), euro.format(w.estimatedCost), <div className="inline-actions"><button onClick={() => onSelect(w.id)}>Abrir ficha</button><button onClick={() => openEdit(w)}>Editar</button><button onClick={() => setStatus(w.id, 1)}>En curso</button><button onClick={() => setStatus(w.id, 3)}>Terminar</button><button className="danger ghost-danger" onClick={() => remove(w)}>Eliminar</button></div>]), ['Total visible', '-', '-', euro.format(filteredTotals.target), euro.format(filteredTotals.estimated), `${filtered.length} partidas`]]} /> : <EmptyState title="No hay partidas con esos filtros." />}</Panel>{selected && <Panel><div className="entity-header"><div><span>{enumLabel(trades, selected.category)}</span><h2>{selected.title}</h2><p>{selected.description || 'Sin descripción.'}</p></div><StatusBadge>{enumLabel(workStatuses, selected.status)}</StatusBadge></div><div className="quick-actions"><button onClick={() => setDrawer('task')}>Crear tarea</button><button onClick={() => setDrawer('budget')}>Solicitar presupuesto</button><button onClick={() => setDrawer('intervention')}>Registrar intervención</button><button onClick={() => setDrawer('issue')}>Registrar incidencia</button><button onClick={() => setDrawer('requirement')}>Añadir requisito</button><button onClick={() => openEdit(selected)}>Editar partida</button></div><KpiGrid items={[['Coste objetivo', euro.format(selected.targetCost)], ['Coste estimado', euro.format(selected.estimatedCost)], [selected.estimatedCost - selected.targetCost <= 0 ? 'Margen estimado' : 'Sobrecoste estimado', euro.format(Math.abs(selected.estimatedCost - selected.targetCost))], ['Presupuestado asociado', euro.format(quoteLinesTotal)], ['Tareas', String(relatedTasks.length)], ['Intervenciones', String(relatedInterventions.length)], ['Solicitudes', String(relatedRequests.length)]]} /><Tabs tabs={[{ id: 'summary', label: 'Resumen' }, { id: 'tasks', label: 'Tareas' }, { id: 'quotes', label: 'Presupuestos' }, { id: 'interventions', label: 'Intervenciones' }, { id: 'followup', label: 'Incidencias y requisitos' }]} active={tab} onChange={setTab} />{tab === 'summary' && <div className="detail-grid"><Detail title={selected.title} description={selected.description || 'Sin descripción.'} rows={[['Estado', enumLabel(workStatuses, selected.status)], ['Prioridad', enumLabel(priorities, selected.priority)], ['Gremio', enumLabel(trades, selected.category)], ['Objetivo', euro.format(selected.targetCost)], ['Estimado', euro.format(selected.estimatedCost)], [selected.estimatedCost - selected.targetCost <= 0 ? 'Margen estimado' : 'Sobrecoste estimado', euro.format(Math.abs(selected.estimatedCost - selected.targetCost))]]} /><ContextNotebookPanel projectId={projectId} entityType="WorkItem" entityId={selected.id} entityName={selected.title} onOpenEntity={onOpenEntity} /></div>}{tab === 'tasks' && <DataTable headers={['Tarea', 'Estado', 'Vence']} rows={relatedTasks.map((x) => [x.title, enumLabel(taskStatuses, x.status), x.dueUtc ? dateTime.format(new Date(x.dueUtc)) : '-'])} />}{tab === 'quotes' && <><h3>Solicitudes</h3><DataTable headers={['Solicitud', 'Estado', 'Límite']} rows={relatedRequests.map((x) => [x.title, enumLabel(budgetRequestStatuses, x.status), x.expectedDeadlineUtc ? dateTime.format(new Date(x.expectedDeadlineUtc)) : '-'])} /><h3>Presupuestos</h3><DataTable headers={['Referencia', 'Proveedor', 'Total']} rows={relatedQuotes.map((x) => [x.reference, x.provider?.displayName || x.provider?.name || '-', euro.format(x.total)])} /></>}{tab === 'interventions' && <DataTable headers={['Trabajo', 'Proveedor', 'Estado', 'Fecha']} rows={relatedInterventions.map((x) => [x.title, x.provider?.displayName || x.provider?.name || '-', enumLabel(interventionStatuses, x.status), x.plannedStartUtc ? dateTime.format(new Date(x.plannedStartUtc)) : '-'])} />}{tab === 'followup' && <><h3>Incidencias</h3><MiniList items={(issues.data || []).filter((x) => `${x.title} ${x.description || ''}`.includes(selected.title)).map((x) => `${enumLabel(severities, x.severity)} · ${x.title}`)} /><h3>Requisitos</h3><MiniList items={(requirements.data || []).filter((x) => x.text.includes(selected.title)).map((x) => x.text)} /></>}</Panel>}{!selected && <EmptyState title="Selecciona una partida para abrir su ficha." />}<Drawer title={drawer === 'new' ? 'Nueva partida' : drawer === 'edit' ? 'Editar partida' : `${selected?.title || 'Partida'} · ${drawer || ''}`} open={drawer !== null} onClose={() => { setDrawer(null); setEditingWorkItemId(null); }}>{(drawer === 'new' || drawer === 'edit') && <form className="form-grid drawer-form" onSubmit={saveWorkItem}><Field label="Título"><input required value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></Field><Field label="Gremio"><select value={draft.category} onChange={(e) => setDraft({ ...draft, category: Number(e.target.value) })}>{enumOptions(trades)}</select></Field><Field label="Estado"><select value={draft.status} onChange={(e) => setDraft({ ...draft, status: Number(e.target.value) })}>{enumOptions(workStatuses)}</select></Field><Field label="Prioridad"><select value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: Number(e.target.value) })}>{enumOptions(priorities)}</select></Field><Field label="Depende de"><select value={draft.dependsOnWorkItemId} onChange={(e) => setDraft({ ...draft, dependsOnWorkItemId: e.target.value })}><option value="">Sin dependencia</option>{(data || []).filter((w) => w.id !== selected?.id).map((w) => <option key={w.id} value={w.id}>{w.title}</option>)}</select></Field><Field label="Coste objetivo"><input type="number" step="0.01" value={draft.targetCost} onChange={(e) => setDraft({ ...draft, targetCost: e.target.value })} /></Field><Field label="Coste estimado"><input type="number" step="0.01" value={draft.estimatedCost} onChange={(e) => setDraft({ ...draft, estimatedCost: e.target.value })} /></Field><Field label="Descripción"><textarea value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></Field><SubmitBar><button className="primary">Guardar partida</button></SubmitBar></form>}{drawer === 'task' && <form className="form-grid drawer-form" onSubmit={createTask}><Field label="Título"><input required value={taskDraft.title} onChange={(e) => setTaskDraft({ ...taskDraft, title: e.target.value })} /></Field><Field label="Contacto"><select value={taskDraft.contactId} onChange={(e) => setTaskDraft({ ...taskDraft, contactId: e.target.value })}><option value="">Sin contacto</option>{(contacts.data || []).map((c) => <option key={c.id} value={c.id}>{c.displayName || c.name}</option>)}</select></Field><Field label="Prioridad"><select value={taskDraft.priority} onChange={(e) => setTaskDraft({ ...taskDraft, priority: Number(e.target.value) })}>{enumOptions(priorities)}</select></Field><Field label="Vencimiento"><input type="datetime-local" value={taskDraft.due} onChange={(e) => setTaskDraft({ ...taskDraft, due: e.target.value })} /></Field><Field label="Descripción"><textarea value={taskDraft.description} onChange={(e) => setTaskDraft({ ...taskDraft, description: e.target.value })} /></Field><SubmitBar><button className="primary">Crear tarea</button></SubmitBar></form>}{drawer === 'budget' && <form className="form-grid drawer-form" onSubmit={createBudget}><Field label="Título"><input required value={budgetDraft.title} onChange={(e) => setBudgetDraft({ ...budgetDraft, title: e.target.value })} /></Field><Field label="Proveedor"><select required value={budgetDraft.providerId} onChange={(e) => setBudgetDraft({ ...budgetDraft, providerId: e.target.value })}><option value="">Seleccionar</option>{(contacts.data || []).map((c) => <option key={c.id} value={c.id}>{c.displayName || c.name}</option>)}</select></Field><Field label="Límite"><input type="datetime-local" value={budgetDraft.expectedDeadline} onChange={(e) => setBudgetDraft({ ...budgetDraft, expectedDeadline: e.target.value })} /></Field><Field label="Visita previa"><span className="check-row"><input type="checkbox" checked={budgetDraft.requiresVisit} onChange={(e) => setBudgetDraft({ ...budgetDraft, requiresVisit: e.target.checked })} />Necesaria</span></Field><Field label="Trabajo solicitado"><textarea required value={budgetDraft.workDescription} onChange={(e) => setBudgetDraft({ ...budgetDraft, workDescription: e.target.value })} /></Field><SubmitBar><button className="primary">Solicitar presupuesto</button></SubmitBar></form>}{drawer === 'intervention' && <form className="form-grid drawer-form" onSubmit={createIntervention}><Field label="Trabajo"><input required value={interventionDraft.title} onChange={(e) => setInterventionDraft({ ...interventionDraft, title: e.target.value })} /></Field><Field label="Proveedor"><select value={interventionDraft.providerId} onChange={(e) => setInterventionDraft({ ...interventionDraft, providerId: e.target.value })}><option value="">Sin proveedor</option>{(contacts.data || []).map((c) => <option key={c.id} value={c.id}>{c.displayName || c.name}</option>)}</select></Field><Field label="Estado"><select value={interventionDraft.status} onChange={(e) => setInterventionDraft({ ...interventionDraft, status: Number(e.target.value) })}>{enumOptions(interventionStatuses)}</select></Field><Field label="Fecha prevista"><input type="datetime-local" value={interventionDraft.plannedStart} onChange={(e) => setInterventionDraft({ ...interventionDraft, plannedStart: e.target.value })} /></Field><Field label="Coste previsto"><input type="number" step="0.01" value={interventionDraft.expectedCost} onChange={(e) => setInterventionDraft({ ...interventionDraft, expectedCost: e.target.value })} /></Field><Field label="Coste acordado"><input type="number" step="0.01" value={interventionDraft.agreedCost} onChange={(e) => setInterventionDraft({ ...interventionDraft, agreedCost: e.target.value })} /></Field><Field label="Descripción"><textarea value={interventionDraft.description} onChange={(e) => setInterventionDraft({ ...interventionDraft, description: e.target.value })} /></Field><SubmitBar><button className="primary">Registrar intervención</button></SubmitBar></form>}{drawer === 'issue' && <form className="form-grid drawer-form" onSubmit={createIssue}><Field label="Título"><input required value={issueDraft.title} onChange={(e) => setIssueDraft({ ...issueDraft, title: e.target.value })} /></Field><Field label="Severidad"><select value={issueDraft.severity} onChange={(e) => setIssueDraft({ ...issueDraft, severity: Number(e.target.value) })}>{enumOptions(severities)}</select></Field><Field label="Estado"><select value={issueDraft.status} onChange={(e) => setIssueDraft({ ...issueDraft, status: Number(e.target.value) })}>{enumOptions(issueStatuses)}</select></Field><Field label="Detectada por"><select value={issueDraft.contactId} onChange={(e) => setIssueDraft({ ...issueDraft, contactId: e.target.value })}><option value="">Sin contacto</option>{(contacts.data || []).map((c) => <option key={c.id} value={c.id}>{c.displayName || c.name}</option>)}</select></Field><Field label="Descripción"><textarea value={issueDraft.description} onChange={(e) => setIssueDraft({ ...issueDraft, description: e.target.value })} /></Field><SubmitBar><button className="primary">Registrar incidencia</button></SubmitBar></form>}{drawer === 'requirement' && <form className="form-grid drawer-form" onSubmit={createRequirement}><Field label="Requisito"><textarea required value={reqDraft.text} onChange={(e) => setReqDraft({ ...reqDraft, text: e.target.value })} /></Field><Field label="Tipo"><select value={reqDraft.type} onChange={(e) => setReqDraft({ ...reqDraft, type: Number(e.target.value) })}>{enumOptions(requirementTypes)}</select></Field><Field label="Comunicado a"><select value={reqDraft.contactId} onChange={(e) => setReqDraft({ ...reqDraft, contactId: e.target.value })}><option value="">Sin contacto</option>{(contacts.data || []).map((c) => <option key={c.id} value={c.id}>{c.displayName || c.name}</option>)}</select></Field><Field label="Cumplimiento"><select value={reqDraft.complianceStatus} onChange={(e) => setReqDraft({ ...reqDraft, complianceStatus: Number(e.target.value) })}>{enumOptions(complianceStatuses)}</select></Field><Field label="Justificación"><textarea value={reqDraft.justification} onChange={(e) => setReqDraft({ ...reqDraft, justification: e.target.value })} /></Field><SubmitBar><button className="primary">Añadir requisito</button></SubmitBar></form>}</Drawer></div>;
}

function TasksPage({ projectId, selectedId, onSelect, onOpenEntity }: { projectId: number; selectedId: number | null; onSelect: (id: number | null) => void; onOpenEntity: (type: string, id: number) => void }) {
  const { data, reload } = useApi<Task[]>(`/api/tasks?projectId=${projectId}`, [projectId]);
  const categories = useApi<TaskCategory[]>(`/api/task-categories?projectId=${projectId}`, [projectId]);
  const contacts = useApi<Contact[]>(`/api/contacts?projectId=${projectId}`, [projectId]);
  const workItems = useApi<WorkItem[]>(`/api/work-items?projectId=${projectId}`, [projectId]);
  const issues = useApi<Issue[]>(`/api/issues?projectId=${projectId}`, [projectId]);
  const params = new URLSearchParams(window.location.search);
  const [mode, setMode] = useState<'board' | 'tree' | 'gantt'>((params.get('mode') as 'board' | 'tree' | 'gantt') || 'board');
  const [filters, setFilters] = useState({ q: params.get('q') || '', status: params.get('status') || '', category: params.get('category') || '', parent: params.get('parent') || '', focus: '' });
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const routeTaskId = Number(window.location.pathname.match(/^\/tasks\/(\d+)/)?.[1] || '') || null;
  const selected = (data || []).find((t) => t.id === (routeTaskId ?? selectedId)) || null;
  const relations = useApi<TaskRelations>(selected ? `/api/tasks/${selected.id}/relations` : '', [selected?.id], Boolean(selected));
  const drawer = window.location.pathname.endsWith('/new') ? 'new' : window.location.pathname.endsWith('/edit') ? 'edit' : null;
  const emptyDraft = { title: '', description: '', status: 0, priority: 1, due: '', contactId: '', responsible: '', blockingReason: '', taskType: 0, parentTaskId: '', sortOrder: 0, progressPercent: 0, plannedStartAt: '', plannedEndAt: '', actualStartAt: '', actualEndAt: '', categoryId: '', primaryWorkItemId: '', issueId: '', timingKind: 0, isPlanningProvisional: false, planningWarning: '' };
  const [draft, setDraft] = useState(emptyDraft);
  const [catDraft, setCatDraft] = useState({ name: '', color: '', sortOrder: 0 });
  const all = data || [];
  const categoryName = (id?: number) => id ? categories.data?.find((c) => c.id === id)?.name || '-' : '-';
  const workItemName = (id?: number) => id ? workItems.data?.find((w) => w.id === id)?.title || `Partida #${id}` : '-';
  const issueName = (id?: number) => id ? issues.data?.find((i) => i.id === id)?.title || `Incidencia #${id}` : '-';
  const childrenOf = (id: number | null) => all.filter((t) => (t.parentTaskId || null) === id).sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || a.id - b.id);
  const isClosed = (task: Task) => task.status === 3 || task.status === 4;
  const isOverdue = (task: Task) => Boolean(task.dueUtc && new Date(task.dueUtc).getTime() < Date.now() && !isClosed(task));
  const hasOwner = (task: Task) => Boolean(task.contact || task.responsible);
  const hasDates = (task: Task) => Boolean(task.plannedStartAt && task.plannedEndAt);
  const hasContext = (task: Task) => Boolean(task.primaryWorkItemId || task.issueId || task.parentTaskId || task.categoryId);
  const dueSoon = (task: Task) => Boolean(task.dueUtc && !isClosed(task) && new Date(task.dueUtc).getTime() < Date.now() + 7 * 86400000);
  const taskWeight = (task: Task) => (isOverdue(task) ? 100 : 0) + (task.status === 2 ? 80 : 0) + (task.status === 1 ? 45 : 0) + (task.priority * 12) + (dueSoon(task) ? 20 : 0) + (!hasOwner(task) ? 8 : 0);
  const progressFor = (task: Task) => {
    const kids = childrenOf(task.id);
    return kids.length ? Math.round(kids.reduce((sum, child) => sum + (child.progressPercent || (child.status === 3 ? 100 : 0)), 0) / kids.length) : task.progressPercent || (task.status === 3 ? 100 : 0);
  };
  const fillDraftFromTask = (task: Task) => {
    setDraft({ title: task.title, description: task.description || '', status: task.status, priority: task.priority, due: task.dueUtc ? localDateTimeValue(new Date(task.dueUtc)) : '', contactId: task.contact?.id ? String(task.contact.id) : '', responsible: task.responsible || '', blockingReason: task.blockingReason || '', taskType: task.taskType ?? 0, parentTaskId: task.parentTaskId ? String(task.parentTaskId) : '', sortOrder: task.sortOrder || 0, progressPercent: task.progressPercent || 0, plannedStartAt: task.plannedStartAt ? localDateTimeValue(new Date(task.plannedStartAt)) : '', plannedEndAt: task.plannedEndAt ? localDateTimeValue(new Date(task.plannedEndAt)) : '', actualStartAt: task.actualStartAt ? localDateTimeValue(new Date(task.actualStartAt)) : '', actualEndAt: task.actualEndAt ? localDateTimeValue(new Date(task.actualEndAt)) : '', categoryId: task.categoryId ? String(task.categoryId) : '', primaryWorkItemId: task.primaryWorkItemId ? String(task.primaryWorkItemId) : '', issueId: task.issueId ? String(task.issueId) : '', timingKind: task.timingKind ?? 0, isPlanningProvisional: task.isPlanningProvisional || false, planningWarning: task.planningWarning || '' });
  };
  useEffect(() => {
    if (drawer === 'edit' && selected) fillDraftFromTask(selected);
    if (drawer === null) setSaveError('');
  }, [drawer, selected?.id]);
  const selectTask = (id: number | null) => { onSelect(id); pushRoute(id ? `/tasks/${id}${mode !== 'tree' ? `?mode=${mode}` : ''}` : `/tasks${mode !== 'tree' ? `?mode=${mode}` : ''}`); };
  const openNew = (parent?: Task) => {
    setSaveError('');
    setDraft({ ...emptyDraft, parentTaskId: parent?.id ? String(parent.id) : '', categoryId: parent?.categoryId ? String(parent.categoryId) : '', primaryWorkItemId: parent?.primaryWorkItemId ? String(parent.primaryWorkItemId) : '', issueId: parent?.issueId ? String(parent.issueId) : '', taskType: 0, sortOrder: childrenOf(parent?.id || null).length + 1 });
    pushRoute('/tasks/new');
  };
  const openEdit = (task: Task) => {
    onSelect(task.id);
    setSaveError('');
    fillDraftFromTask(task);
    pushRoute(`/tasks/${task.id}/edit`);
  };
  const validateDraft = () => {
    const messages: string[] = [];
    if (!draft.title.trim()) messages.push('La tarea necesita título.');
    if (Number(draft.status) === 2 && !draft.blockingReason.trim()) messages.push('Una tarea bloqueada debe explicar el bloqueo.');
    if (draft.plannedStartAt && draft.plannedEndAt && new Date(draft.plannedStartAt) > new Date(draft.plannedEndAt)) messages.push('La fecha de inicio previsto no puede ser posterior al fin previsto.');
    if (Number(draft.progressPercent) < 0 || Number(draft.progressPercent) > 100) messages.push('El progreso debe estar entre 0 y 100.');
    return messages;
  };
  const draftWarnings = validateDraft();
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    const validation = validateDraft();
    if (validation.length) { setSaveError(validation.join(' ')); return; }
    setSaving(true);
    setSaveError('');
    try {
      const body = { projectId, title: draft.title.trim(), description: draft.description, status: Number(draft.status), priority: Number(draft.priority), responsible: draft.responsible, dueUtc: toUtc(draft.due), contactId: draft.contactId ? Number(draft.contactId) : null, blockingReason: draft.blockingReason, taskType: Number(draft.taskType), parentTaskId: draft.parentTaskId ? Number(draft.parentTaskId) : null, sortOrder: Number(draft.sortOrder), progressPercent: Math.max(0, Math.min(100, Number(draft.progressPercent))), plannedStartAt: toUtc(draft.plannedStartAt), plannedEndAt: toUtc(draft.plannedEndAt), actualStartAt: toUtc(draft.actualStartAt), actualEndAt: toUtc(draft.actualEndAt), categoryId: draft.categoryId ? Number(draft.categoryId) : null, primaryWorkItemId: draft.primaryWorkItemId ? Number(draft.primaryWorkItemId) : null, issueId: draft.issueId ? Number(draft.issueId) : null, timingKind: Number(draft.timingKind), isPlanningProvisional: Boolean(draft.isPlanningProvisional), planningWarning: draft.planningWarning || null };
      if (drawer === 'edit') {
        const editId = routeTaskId ?? selected?.id;
        if (!editId) throw new Error('No se puede guardar la edición porque no hay una tarea seleccionada.');
        await api.put(`/api/tasks/${editId}`, body);
      } else if (drawer === 'new') await api.post('/api/tasks', body);
      else throw new Error('Acción de tarea no válida.');
      window.history.back();
      await reload();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'No se pudo guardar la tarea.');
    } finally {
      setSaving(false);
    }
  };
  const setModeRoute = (next: 'board' | 'tree' | 'gantt') => { setMode(next); pushRoute(`/tasks${selectedId ? `/${selectedId}` : ''}?mode=${next}`); };
  const setStatus = async (id: number, status: number, blockingReason?: string) => { await api.patch(`/api/tasks/${id}/status`, { status, blockingReason }); await reload(); };
  const blockTask = async (task: Task) => { const reason = window.prompt('Motivo del bloqueo', task.blockingReason || ''); if (reason === null) return; await setStatus(task.id, 2, reason || 'Bloqueada'); };
  const convertType = async (task: Task, type: number) => { await api.patch(`/api/tasks/${task.id}/type`, { taskType: type }); await reload(); };
  const moveTask = async (task: Task, parentTaskId: string) => { await api.patch(`/api/tasks/${task.id}/move`, { parentTaskId: parentTaskId ? Number(parentTaskId) : null, sortOrder: task.sortOrder || 0 }); await reload(); };
  const saveCategory = async (event: React.FormEvent) => { event.preventDefault(); if (!catDraft.name.trim()) return; await api.post('/api/task-categories', { projectId, name: catDraft.name.trim(), color: catDraft.color || null, sortOrder: Number(catDraft.sortOrder) }); setCatDraft({ name: '', color: '', sortOrder: 0 }); await categories.reload(); };
  const matchesFocus = (task: Task) => !filters.focus
    || (filters.focus === 'active' && !isClosed(task))
    || (filters.focus === 'blocked' && task.status === 2)
    || (filters.focus === 'missing' && (!hasOwner(task) || !hasDates(task) || !hasContext(task)))
    || (filters.focus === 'overdue' && isOverdue(task));
  const filtered = all.filter((t) => matchesFocus(t) && matchesSearch(filters.q, t.title, t.description, t.contact?.displayName, t.contact?.name, t.responsible, categoryName(t.categoryId), workItemName(t.primaryWorkItemId), issueName(t.issueId), enumLabel(taskStatuses, t.status), enumLabel(taskTypes, t.taskType), enumLabel(taskTimingKinds, t.timingKind || 0), t.planningWarning) && (!filters.status || t.status === Number(filters.status)) && (!filters.category || t.categoryId === Number(filters.category)) && (!filters.parent || (filters.parent === 'root' ? !t.parentTaskId : filters.parent === 'epic' ? t.taskType === 1 : t.parentTaskId === Number(filters.parent))));
  const visibleRoots = filtered.filter((t) => !t.parentTaskId);
  const activeQueue = all.filter((t) => !isClosed(t)).sort((a, b) => taskWeight(b) - taskWeight(a)).slice(0, 8);
  const blocked = all.filter((t) => t.status === 2).sort((a, b) => taskWeight(b) - taskWeight(a));
  const missing = all.filter((t) => !isClosed(t) && (!hasOwner(t) || !hasDates(t) || !hasContext(t))).slice(0, 8);
  const nextMilestones = all.filter((t) => !isClosed(t) && (t.taskType === 2 || t.timingKind === 2)).sort((a, b) => (new Date(a.plannedEndAt || a.dueUtc || '2999-01-01').getTime()) - (new Date(b.plannedEndAt || b.dueUtc || '2999-01-01').getTime())).slice(0, 5);
  const taskKpis: Array<[string, string]> = [
    ['Abiertas', String(all.filter((t) => !isClosed(t)).length)],
    ['En curso', String(all.filter((t) => t.status === 1).length)],
    ['Bloqueadas', String(blocked.length)],
    ['Vencidas', String(all.filter(isOverdue).length)],
    ['Sin dueño/fecha/contexto', String(missing.length)],
    ['Completadas', String(all.filter((t) => t.status === 3).length)]
  ];
  const renderQueue = (items: Task[], empty: string) => items.length ? <div className="task-card-list">{items.map((task) => <button key={task.id} className={selected?.id === task.id ? 'active' : ''} onClick={() => selectTask(task.id)}><b>{task.title}</b><span>{enumLabel(taskStatuses, task.status)} · {categoryName(task.categoryId)} · {task.dueUtc ? dateOnly.format(new Date(task.dueUtc)) : 'sin vencimiento'}</span></button>)}</div> : <p className="note">{empty}</p>;
  const renderRow = (task: Task, level = 0): React.ReactNode[] => {
    const kids = childrenOf(task.id).filter((child) => filtered.includes(child));
    const isEpic = task.taskType === 1;
    const row = <tr key={task.id} className={level ? 'child-row' : ''}><td data-label="Tarea" style={{ paddingLeft: 12 + level * 24 }}>{isEpic && <button className="icon-button" onClick={() => setExpanded((old) => { const next = new Set(old); next.has(task.id) ? next.delete(task.id) : next.add(task.id); return next; })}>{expanded.has(task.id) ? '−' : '+'}</button>}<button className="link-button" onClick={() => selectTask(task.id)}>{task.title}</button></td><td data-label="Tipo"><StatusBadge>{enumLabel(taskTypes, task.taskType)}</StatusBadge></td><td data-label="Tiempo"><StatusBadge>{enumLabel(taskTimingKinds, task.timingKind || 0)}</StatusBadge>{task.isPlanningProvisional && <StatusBadge>Provisional</StatusBadge>}</td><td data-label="Contexto">{workItemName(task.primaryWorkItemId)}<br /><small>{issueName(task.issueId)}</small></td><td data-label="Estado"><StatusBadge>{enumLabel(taskStatuses, task.status)}</StatusBadge></td><td data-label="Plan">{task.plannedStartAt ? dateOnly.format(new Date(task.plannedStartAt)) : '-'} → {task.plannedEndAt ? dateOnly.format(new Date(task.plannedEndAt)) : '-'}</td><td data-label="Progreso"><progress max="100" value={progressFor(task)} /> {progressFor(task)}%</td><td data-label="Responsable">{task.blockingReason ? <StatusBadge>Bloqueada</StatusBadge> : task.contact?.displayName || task.contact?.name || task.responsible || '-'}</td><td data-label="Acciones"><div className="inline-actions"><button onClick={() => openEdit(task)}>Editar</button><button onClick={() => openNew(task)}>Crear hija</button><button onClick={() => convertType(task, task.taskType === 1 ? 0 : 1)}>{task.taskType === 1 ? 'Hacer tarea' : 'Hacer épica'}</button><select value={task.parentTaskId || ''} onChange={(e) => moveTask(task, e.target.value)}><option value="">Raíz</option>{all.filter((t) => t.id !== task.id && t.taskType === 1).map((epic) => <option key={epic.id} value={epic.id}>{epic.title}</option>)}</select></div></td></tr>;
    return expanded.has(task.id) ? [row, ...kids.flatMap((child) => renderRow(child, level + 1))] : [row];
  };
  const ganttRows = filtered.filter((task) => task.plannedStartAt && task.plannedEndAt);
  const baseDate = ganttRows.length ? Math.min(...ganttRows.map((task) => new Date(task.plannedStartAt!).getTime())) : Date.now();
  const spanDays = Math.max(30, ganttRows.length ? Math.ceil((Math.max(...ganttRows.map((task) => new Date(task.plannedEndAt!).getTime())) - baseDate) / 86400000) + 3 : 30);
  const unscheduled = filtered.filter((task) => !task.plannedStartAt || !task.plannedEndAt);
  const selectedChildren = selected ? childrenOf(selected.id) : [];
  const selectedHealth = selected ? [
    ['Contexto', hasContext(selected), selected.primaryWorkItemId ? workItemName(selected.primaryWorkItemId) : selected.issueId ? issueName(selected.issueId) : 'Sin partida/incidencia/categoría'],
    ['Responsable', hasOwner(selected), selected.contact?.displayName || selected.contact?.name || selected.responsible || 'Sin responsable'],
    ['Planificación', hasDates(selected), selected.plannedStartAt && selected.plannedEndAt ? `${dateOnly.format(new Date(selected.plannedStartAt))} → ${dateOnly.format(new Date(selected.plannedEndAt))}` : 'Sin inicio/fin previsto'],
    ['Riesgo', !selected.blockingReason && !selected.planningWarning, selected.blockingReason || selected.planningWarning || 'Sin bloqueo visible'],
    ['Ejecución', progressFor(selected) > 0 || selected.status !== 0, `${progressFor(selected)}% · ${enumLabel(taskStatuses, selected.status)}`]
  ] as Array<[string, boolean, string]> : [];
  return <div className="page-grid task-page"><PageHeader title="Tareas" summary="Centro operativo: cola de trabajo, planificación, contexto, riesgos y ejecución alrededor de cada tarea." action={<PrimaryAction onClick={() => openNew()}>Nueva tarea</PrimaryAction>} /><KpiGrid items={taskKpis} /><section className="task-command-grid"><Panel title="Cola priorizada">{renderQueue(activeQueue, 'No hay tareas abiertas.')}</Panel><Panel title="Bloqueos">{renderQueue(blocked.slice(0, 6), 'Sin bloqueos activos.')}</Panel><Panel title="Faltan datos">{renderQueue(missing, 'Las tareas abiertas tienen responsable, fechas y contexto suficientes.')}</Panel><Panel title="Próximos hitos">{renderQueue(nextMilestones, 'Sin hitos próximos.')}</Panel></section><div className="toolbar"><button className={mode === 'board' ? 'primary' : ''} onClick={() => setModeRoute('board')}>Mesa</button><button className={mode === 'tree' ? 'primary' : ''} onClick={() => setModeRoute('tree')}>Jerarquía</button><button className={mode === 'gantt' ? 'primary' : ''} onClick={() => setModeRoute('gantt')}>Gantt</button><button onClick={() => setExpanded(new Set(all.filter((t) => t.taskType === 1).map((t) => t.id)))}>Expandir épicas</button><button onClick={() => setExpanded(new Set())}>Contraer</button></div><Panel title="Filtros operativos"><div className="filter-bar task-filter-bar"><input placeholder="Buscar tarea, responsable, partida, incidencia o aviso..." value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value })} /><select value={filters.focus} onChange={(e) => setFilters({ ...filters, focus: e.target.value })}><option value="">Todo</option><option value="active">Abiertas</option><option value="blocked">Bloqueadas</option><option value="missing">Faltan datos</option><option value="overdue">Vencidas</option></select><select value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}><option value="">Todos los estados</option>{enumOptions(taskStatuses)}</select><select value={filters.category} onChange={(e) => setFilters({ ...filters, category: e.target.value })}><option value="">Todas las categorías</option>{(categories.data || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select><select value={filters.parent} onChange={(e) => setFilters({ ...filters, parent: e.target.value })}><option value="">Toda la jerarquía</option><option value="root">Raíz</option><option value="epic">Épicas</option>{all.filter((t) => t.taskType === 1).map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}</select></div></Panel>{mode === 'board' && <Panel title="Mesa de tareas">{filtered.length ? <div className="task-board-list">{filtered.sort((a, b) => taskWeight(b) - taskWeight(a)).map((task) => <article key={task.id} className={selected?.id === task.id ? 'selected' : ''}><button className="link-button" onClick={() => selectTask(task.id)}>{task.title}</button><div className="task-board-meta"><StatusBadge>{enumLabel(taskStatuses, task.status)}</StatusBadge><span>{enumLabel(priorities, task.priority)}</span><span>{workItemName(task.primaryWorkItemId)}</span><span>{task.contact?.displayName || task.contact?.name || task.responsible || 'Sin responsable'}</span></div><progress max="100" value={progressFor(task)} /><div className="inline-actions"><button onClick={() => openEdit(task)}>Editar</button>{task.status !== 1 && <button onClick={() => setStatus(task.id, 1)}>Iniciar</button>}<button onClick={() => blockTask(task)}>Bloquear</button><button onClick={() => setStatus(task.id, 3)}>Completar</button><button onClick={() => openNew(task)}>Subtarea</button></div></article>)}</div> : <EmptyState title="No hay tareas con esos filtros." />}</Panel>}{mode === 'tree' && <Panel title="Jerarquía">{filtered.length ? <div className="table-wrap"><table><thead><tr><th>Tarea</th><th>Tipo</th><th>Tiempo</th><th>Contexto</th><th>Estado</th><th>Plan</th><th>Progreso</th><th>Responsable</th><th>Acciones</th></tr></thead><tbody>{visibleRoots.flatMap((task) => renderRow(task))}</tbody></table></div> : <EmptyState title="No hay tareas con esos filtros." />}</Panel>}{mode === 'gantt' && <Panel title="Gantt previsto"><div className="gantt-scale"><span>Inicio</span><span>{spanDays} días</span><button onClick={() => setModeRoute('gantt')}>Hoy</button></div><div className="gantt-chart">{ganttRows.map((task) => { const start = Math.max(0, Math.round((new Date(task.plannedStartAt!).getTime() - baseDate) / 86400000)); const len = Math.max(1, Math.round((new Date(task.plannedEndAt!).getTime() - new Date(task.plannedStartAt!).getTime()) / 86400000) + 1); return <button key={task.id} className={`gantt-row type-${task.taskType} timing-${task.timingKind || 0}${task.isPlanningProvisional ? " provisional" : ""}`} onClick={() => selectTask(task.id)}><span><span className="gantt-label-text">{task.title}</span>{task.planningWarning && <span className="gantt-warning" title={task.planningWarning} aria-label={`Advertencia: ${task.planningWarning}`}><Info size={13} /></span>}</span><i style={{ left: `${(start / spanDays) * 100}%`, width: `${(len / spanDays) * 100}%` }} /></button>; })}</div>{unscheduled.length > 0 && <div className="unscheduled"><b>Sin fechas previstas</b><div className="tag-row">{unscheduled.map((task) => <button key={task.id} className="tag-link neutral" onClick={() => selectTask(task.id)}>{task.title}</button>)}</div></div>}</Panel>}{selected && <Panel><div className="entity-header"><div><span>{enumLabel(taskTypes, selected.taskType)} · {enumLabel(taskTimingKinds, selected.timingKind || 0)} · {categoryName(selected.categoryId)}</span><h2>{selected.title}</h2><p>{selected.description || 'Sin descripción.'}</p></div><StatusBadge>{enumLabel(taskStatuses, selected.status)}</StatusBadge></div><div className="quick-actions"><button onClick={() => openEdit(selected)}>Editar ficha</button><button onClick={() => setStatus(selected.id, 1)}>Iniciar</button><button onClick={() => blockTask(selected)}>Bloquear</button><button onClick={() => setStatus(selected.id, 3)}>Completar</button><button onClick={() => openNew(selected)}>Crear subtarea</button></div><div className="task-workbench"><section className="task-readiness"><h3>Preparación</h3>{selectedHealth.map(([label, ok, detail]) => <div key={label} className={ok ? 'ok' : 'warn'}><b>{ok ? '✓' : '!'}</b><span>{label}</span><small>{detail}</small></div>)}</section><section className="task-flow"><h3>Flujo</h3>{taskStatuses.map((label, index) => <button key={label} className={selected.status === index ? 'active' : selected.status > index ? 'done' : ''} onClick={() => index === 2 ? blockTask(selected) : setStatus(selected.id, index)}>{label}</button>)}</section><section className="task-context-actions"><h3>Contexto</h3><button disabled={!selected.primaryWorkItemId} onClick={() => selected.primaryWorkItemId && onOpenEntity('WorkItem', selected.primaryWorkItemId)}>Abrir partida: {workItemName(selected.primaryWorkItemId)}</button><button disabled={!selected.issueId} onClick={() => selected.issueId && onOpenEntity('Issue', selected.issueId)}>Abrir incidencia: {issueName(selected.issueId)}</button><button disabled={!selected.contact?.id} onClick={() => selected.contact?.id && onOpenEntity('Contact', selected.contact.id)}>Abrir contacto: {selected.contact?.displayName || selected.contact?.name || '-'}</button></section></div><KpiGrid items={[['Progreso', `${progressFor(selected)}%`], ['Inicio previsto', selected.plannedStartAt ? dateOnly.format(new Date(selected.plannedStartAt)) : '-'], ['Fin previsto', selected.plannedEndAt ? dateOnly.format(new Date(selected.plannedEndAt)) : '-'], ['Subtareas', String(selectedChildren.length)], ['Incidencias', String(relations.data?.issues.length || 0)], ['Presupuestos', String((relations.data?.budgetRequests.length || 0) + (relations.data?.quotes.length || 0))]]} /><div className="detail-grid"><Detail title="Ficha operativa" rows={[['Épica', selected.parentTaskId ? all.find((t) => t.id === selected.parentTaskId)?.title || '-' : '-'], ['Partida', workItemName(selected.primaryWorkItemId)], ['Incidencia principal', issueName(selected.issueId)], ['Categoría', categoryName(selected.categoryId)], ['Tipo temporal', enumLabel(taskTimingKinds, selected.timingKind || 0)], ['Responsable', selected.contact?.displayName || selected.contact?.name || selected.responsible || '-'], ['Bloqueo', selected.blockingReason || '-'], ['Advertencia', selected.planningWarning || '-']]} /><ContextNotebookPanel projectId={projectId} entityType="Task" entityId={selected.id} entityName={selected.title} onOpenEntity={onOpenEntity} /></div><section className="task-relations-grid"><Panel title="Subtareas">{selectedChildren.length ? renderQueue(selectedChildren, '') : <EmptyState title="Sin subtareas." action={<button onClick={() => openNew(selected)}>Crear subtarea</button>} />}</Panel><Panel title="Incidencias">{relations.data?.issues.length ? <div className="tag-row">{relations.data.issues.map((issue) => <button className="tag-link" key={issue.id} onClick={() => onOpenEntity('Issue', issue.id)}>{issue.title}</button>)}</div> : <EmptyState title="Sin incidencias vinculadas." />}</Panel><Panel title="Intervenciones">{relations.data?.interventions.length ? <div className="tag-row">{relations.data.interventions.map((intervention) => <button className="tag-link" key={intervention.id} onClick={() => onOpenEntity('Intervention', intervention.id)}>{intervention.title}</button>)}</div> : <EmptyState title="Sin intervenciones vinculadas." />}</Panel><Panel title="Presupuestos">{(relations.data?.budgetRequests.length || relations.data?.quotes.length) ? <div className="tag-row">{relations.data?.budgetRequests.map((request) => <button className="tag-link" key={`r${request.id}`} onClick={() => onOpenEntity('BudgetRequest', request.id)}>{request.title}</button>)}{relations.data?.quotes.map((quote) => <button className="tag-link" key={`q${quote.id}`} onClick={() => onOpenEntity('Quote', quote.id)}>{quote.reference}</button>)}</div> : <EmptyState title="Sin solicitudes o presupuestos vinculados." />}</Panel></section></Panel>}<Panel title="Categorías"><form className="form-grid" onSubmit={saveCategory}><Field label="Nueva categoría"><input value={catDraft.name} onChange={(e) => setCatDraft({ ...catDraft, name: e.target.value })} /></Field><Field label="Color"><input value={catDraft.color} onChange={(e) => setCatDraft({ ...catDraft, color: e.target.value })} placeholder="#0f766e" /></Field><Field label="Orden"><input type="number" value={catDraft.sortOrder} onChange={(e) => setCatDraft({ ...catDraft, sortOrder: Number(e.target.value) })} /></Field><SubmitBar><button className="primary">Añadir categoría</button></SubmitBar></form><div className="tag-row">{(categories.data || []).map((c) => <span key={c.id}>{c.name}</span>)}</div></Panel><Drawer title={drawer === 'edit' ? 'Editar tarea' : 'Nueva tarea'} open={drawer !== null} onClose={() => window.history.back()}><form className="task-form" onSubmit={save}><aside className="task-form-summary"><span>{drawer === 'edit' ? 'Editando' : 'Nueva tarea'}</span><h3>{draft.title || 'Sin título'}</h3><p>{enumLabel(taskStatuses, Number(draft.status))} · {enumLabel(priorities, Number(draft.priority))}</p><progress max="100" value={Number(draft.progressPercent) || 0} /><div className="task-form-checks">{draftWarnings.length ? draftWarnings.map((warning) => <small key={warning} className="warn">{warning}</small>) : <small className="ok">Lista para guardar.</small>}</div></aside><section className="task-form-sections"><div className="form-section"><h3>Identidad</h3><div className="form-grid drawer-form"><Field label="Título"><input required value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></Field><Field label="Tipo"><select value={draft.taskType} onChange={(e) => setDraft({ ...draft, taskType: Number(e.target.value) })}>{enumOptions(taskTypes)}</select></Field><Field label="Estado"><select value={draft.status} onChange={(e) => setDraft({ ...draft, status: Number(e.target.value) })}>{enumOptions(taskStatuses)}</select></Field><Field label="Prioridad"><select value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: Number(e.target.value) })}>{enumOptions(priorities)}</select></Field><Field label="Descripción"><textarea value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></Field></div></div><div className="form-section"><h3>Contexto operativo</h3><div className="form-grid drawer-form"><Field label="Épica"><select value={draft.parentTaskId} onChange={(e) => setDraft({ ...draft, parentTaskId: e.target.value })}><option value="">Raíz</option>{all.filter((t) => t.taskType === 1 && t.id !== selected?.id).map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}</select></Field><Field label="Categoría"><select value={draft.categoryId} onChange={(e) => setDraft({ ...draft, categoryId: e.target.value })}><option value="">Sin categoría</option>{(categories.data || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field><Field label="Partida principal"><select value={draft.primaryWorkItemId} onChange={(e) => setDraft({ ...draft, primaryWorkItemId: e.target.value })}><option value="">Sin partida</option>{(workItems.data || []).map((w) => <option key={w.id} value={w.id}>{w.title}</option>)}</select></Field><Field label="Incidencia principal"><select value={draft.issueId} onChange={(e) => setDraft({ ...draft, issueId: e.target.value })}><option value="">Sin incidencia</option>{(issues.data || []).map((i) => <option key={i.id} value={i.id}>{i.title}</option>)}</select></Field><Field label="Contacto"><select value={draft.contactId} onChange={(e) => setDraft({ ...draft, contactId: e.target.value })}><option value="">Sin contacto</option>{(contacts.data || []).map((c) => <option key={c.id} value={c.id}>{c.displayName || c.name}</option>)}</select></Field><Field label="Responsable libre"><input value={draft.responsible} onChange={(e) => setDraft({ ...draft, responsible: e.target.value })} /></Field></div></div><div className="form-section"><h3>Planificación y ejecución</h3><div className="form-grid drawer-form"><Field label="Tipo temporal"><select value={draft.timingKind} onChange={(e) => setDraft({ ...draft, timingKind: Number(e.target.value) })}>{enumOptions(taskTimingKinds)}</select></Field><Field label="Progreso %"><input type="number" min="0" max="100" value={draft.progressPercent} onChange={(e) => setDraft({ ...draft, progressPercent: Number(e.target.value) })} /></Field><Field label="Inicio previsto"><input type="datetime-local" value={draft.plannedStartAt} onChange={(e) => setDraft({ ...draft, plannedStartAt: e.target.value })} /></Field><Field label="Fin previsto"><input type="datetime-local" value={draft.plannedEndAt} onChange={(e) => setDraft({ ...draft, plannedEndAt: e.target.value })} /></Field><Field label="Inicio real"><input type="datetime-local" value={draft.actualStartAt} onChange={(e) => setDraft({ ...draft, actualStartAt: e.target.value })} /></Field><Field label="Fin real"><input type="datetime-local" value={draft.actualEndAt} onChange={(e) => setDraft({ ...draft, actualEndAt: e.target.value })} /></Field><Field label="Vencimiento estricto"><input type="datetime-local" value={draft.due} onChange={(e) => setDraft({ ...draft, due: e.target.value })} /></Field><Field label="Orden"><input type="number" value={draft.sortOrder} onChange={(e) => setDraft({ ...draft, sortOrder: Number(e.target.value) })} /></Field></div></div><div className="form-section"><h3>Riesgos</h3><div className="form-grid drawer-form"><Field label="Planificación provisional"><span className="check-row"><input type="checkbox" checked={draft.isPlanningProvisional} onChange={(e) => setDraft({ ...draft, isPlanningProvisional: e.target.checked })} />Marcar como provisional</span></Field><Field label="Motivo de bloqueo"><textarea value={draft.blockingReason} onChange={(e) => setDraft({ ...draft, blockingReason: e.target.value })} /></Field><Field label="Advertencia de planificación"><textarea value={draft.planningWarning} onChange={(e) => setDraft({ ...draft, planningWarning: e.target.value })} /></Field></div></div><SubmitBar error={saveError}><button className="primary" disabled={saving}>{saving ? 'Guardando...' : 'Guardar tarea'}</button><button type="button" onClick={() => window.history.back()} disabled={saving}>Cancelar</button></SubmitBar></section></form></Drawer></div>;
}

function LegacyTasksPage({ projectId, selectedId, onSelect, onOpenEntity }: { projectId: number; selectedId: number | null; onSelect: (id: number | null) => void; onOpenEntity: (type: string, id: number) => void }) {
  const { data, reload } = useApi<Task[]>(`/api/tasks?projectId=${projectId}`, [projectId]);
  const contacts = useApi<Contact[]>(`/api/contacts?projectId=${projectId}`, [projectId]);
  const links = useApi<EntityLink[]>(`/api/entity-links?projectId=${projectId}`, [projectId]);
  const issues = useApi<Issue[]>(`/api/issues?projectId=${projectId}`, [projectId]);
  const interventions = useApi<Intervention[]>(`/api/interventions?projectId=${projectId}`, [projectId]);
  const [filters, setFilters] = useState({ q: '', status: '', priority: '', link: '' });
  const [drawer, setDrawer] = useState<'new' | 'edit' | null>(null);
  const [editing, setEditing] = useState<Task | null>(null);
  const [draft, setDraft] = useState({ title: '', description: '', status: 0, priority: 1, due: '', contactId: '', responsible: '', blockingReason: '' });
  const taskLinks = (taskId: number, type?: string) => (links.data || []).filter((link) => {
    const touchesTask = (link.sourceType === 'Task' && link.sourceId === taskId) || (link.targetType === 'Task' && link.targetId === taskId);
    if (!touchesTask) return false;
    if (!type) return true;
    return (link.sourceType === type && link.sourceId !== taskId) || (link.targetType === type && link.targetId !== taskId);
  });
  const linkedIssues = (taskId: number) => taskLinks(taskId, 'Issue').map((link) => {
    const id = link.sourceType === 'Issue' ? link.sourceId : link.targetId;
    return (issues.data || []).find((issue) => issue.id === id);
  }).filter(Boolean) as Issue[];
  const linkedInterventions = (taskId: number) => taskLinks(taskId, 'Intervention').map((link) => {
    const id = link.sourceType === 'Intervention' ? link.sourceId : link.targetId;
    return (interventions.data || []).find((intervention) => intervention.id === id);
  }).filter(Boolean) as Intervention[];
  const selected = (data || []).find((t) => t.id === selectedId) || null;
  const selectedIssues = selected ? linkedIssues(selected.id) : [];
  const selectedInterventions = selected ? linkedInterventions(selected.id) : [];
  const issueGroups = (issues.data || []).map((issue) => ({ issue, tasks: (data || []).filter((task) => linkedIssues(task.id).some((linked) => linked.id === issue.id)) })).filter((group) => group.tasks.length > 0);
  const interventionGroups = (interventions.data || []).map((intervention) => ({ intervention, tasks: (data || []).filter((task) => linkedInterventions(task.id).some((linked) => linked.id === intervention.id)) })).filter((group) => group.tasks.length > 0);
  const unlinkedTasks = (data || []).filter((task) => taskLinks(task.id).length === 0);
  const filtered = (data || []).filter((t) => {
    const allLinks = taskLinks(t.id);
    const hasIssue = taskLinks(t.id, 'Issue').length > 0;
    const hasIntervention = taskLinks(t.id, 'Intervention').length > 0;
    return (!filters.q || `${t.title} ${t.description || ''} ${t.contact?.displayName || t.contact?.name || ''}`.toLowerCase().includes(filters.q.toLowerCase()))
      && (!filters.status || t.status === Number(filters.status))
      && (!filters.priority || t.priority === Number(filters.priority))
      && (!filters.link || (filters.link === 'issue' && hasIssue) || (filters.link === 'intervention' && hasIntervention) || (filters.link === 'none' && allLinks.length === 0));
  });
  const openEdit = (t: Task) => { setEditing(t); setDraft({ title: t.title, description: t.description || '', status: t.status, priority: t.priority, due: t.dueUtc ? localDateTimeValue(new Date(t.dueUtc)) : '', contactId: t.contact?.id ? String(t.contact.id) : '', responsible: t.responsible || '', blockingReason: t.blockingReason || '' }); setDrawer('edit'); };
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    const body = { projectId, title: draft.title, description: draft.description, status: Number(draft.status), priority: Number(draft.priority), responsible: draft.responsible, dueUtc: toUtc(draft.due), contactId: draft.contactId ? Number(draft.contactId) : null, blockingReason: draft.blockingReason };
    if (drawer === 'edit') {
      if (!editing) throw new Error('No se puede guardar la edición porque no hay una tarea seleccionada.');
      await api.put(`/api/tasks/${editing.id}`, body);
    } else if (drawer === 'new') await api.post('/api/tasks', body);
    else throw new Error('Acción de tarea no válida.');
    setDrawer(null);
    setEditing(null);
    setDraft({ title: '', description: '', status: 0, priority: 1, due: '', contactId: '', responsible: '', blockingReason: '' });
    await reload();
  };
  const setStatus = async (id: number, status: number, blockingReason?: string) => { await api.patch(`/api/tasks/${id}/status`, { status, blockingReason }); await reload(); };
  const remove = async (t: Task) => { if (!window.confirm(`Eliminar tarea "${t.title}"?`)) return; await api.delete(`/api/tasks/${t.id}`); if (selectedId === t.id) onSelect(null); await reload(); };
  const counts = taskStatuses.map((label, status) => [label, (data || []).filter((t) => t.status === status).length] as [string, number]).filter(([, count]) => count > 0);
  return <div className="page-grid"><PageHeader title="Tareas" summary="Trabajo pendiente agrupado por incidencias, intervenciones y vínculos contextuales." action={<PrimaryAction onClick={() => setDrawer('new')}>Nueva tarea</PrimaryAction>} /><StatusSummary items={counts} /><Panel title="Mapa de vínculos"><div className="relation-board"><section><h3>Por incidencia</h3>{issueGroups.length ? issueGroups.map(({ issue, tasks: groupTasks }) => <article key={issue.id}><button className="link-button" onClick={() => onOpenEntity('Issue', issue.id)}>{issue.title}</button><span>{enumLabel(issueStatuses, issue.status)} · {enumLabel(severities, issue.severity)}</span><div className="tag-row">{groupTasks.map((task) => <button key={task.id} className="tag-link" onClick={() => onSelect(task.id)}>{task.title}</button>)}</div></article>) : <p className="note">Aún no hay tareas vinculadas a incidencias.</p>}</section><section><h3>Por intervención</h3>{interventionGroups.length ? interventionGroups.map(({ intervention, tasks: groupTasks }) => <article key={intervention.id}><button className="link-button" onClick={() => onOpenEntity('Intervention', intervention.id)}>{intervention.title}</button><span>{enumLabel(interventionStatuses, intervention.status)} · {intervention.provider?.displayName || intervention.provider?.name || 'Sin proveedor'}</span><div className="tag-row">{groupTasks.map((task) => <button key={task.id} className="tag-link" onClick={() => onSelect(task.id)}>{task.title}</button>)}</div></article>) : <p className="note">Aún no hay tareas vinculadas a intervenciones.</p>}</section><section><h3>Sin agrupar</h3>{unlinkedTasks.length ? <div className="tag-row">{unlinkedTasks.map((task) => <button key={task.id} className="tag-link neutral" onClick={() => onSelect(task.id)}>{task.title}</button>)}</div> : <p className="note">Todas las tareas tienen contexto.</p>}</section></div></Panel><Panel title="Listado de tareas"><div className="filter-bar"><input placeholder="Buscar tarea..." value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value })} /><select value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}><option value="">Todos los estados</option>{enumOptions(taskStatuses)}</select><select value={filters.priority} onChange={(e) => setFilters({ ...filters, priority: e.target.value })}><option value="">Todas las prioridades</option>{enumOptions(priorities)}</select><select value={filters.link} onChange={(e) => setFilters({ ...filters, link: e.target.value })}><option value="">Todos los vínculos</option><option value="issue">Con incidencia</option><option value="intervention">Con intervención</option><option value="none">Sin vínculos</option></select></div>{filtered.length ? <DataTable headers={['Tarea', 'Estado', 'Prioridad', 'Contacto', 'Vence', 'Vínculos', 'Acciones']} rows={filtered.map((t) => {
    const issueCount = taskLinks(t.id, 'Issue').length;
    const interventionCount = taskLinks(t.id, 'Intervention').length;
    const totalLinks = taskLinks(t.id).length;
    return [<button className="link-button" onClick={() => onSelect(t.id)}>{t.title}</button>, <StatusBadge>{enumLabel(taskStatuses, t.status)}</StatusBadge>, enumLabel(priorities, t.priority), t.contact?.displayName || t.contact?.name || '-', t.dueUtc ? dateTime.format(new Date(t.dueUtc)) : '-', <div className="tag-row">{issueCount > 0 && <span>Incidencias {issueCount}</span>}{interventionCount > 0 && <span>Intervenciones {interventionCount}</span>}{totalLinks === 0 && <span>Sin vínculos</span>}</div>, <div className="inline-actions"><button onClick={() => onSelect(t.id)}>Abrir ficha</button><button onClick={() => openEdit(t)}>Editar</button><button onClick={() => setStatus(t.id, 1)}>Iniciar</button><button onClick={() => setStatus(t.id, 3)}>Completar</button><button className="danger ghost-danger" onClick={() => remove(t)}>Eliminar</button></div>];
  })} /> : <EmptyState title="No hay tareas con esos filtros." />}</Panel>{selected && <Panel><div className="entity-header"><div><span>{selected.contact?.displayName || selected.contact?.name || selected.responsible || 'Sin responsable asignado'}</span><h2>{selected.title}</h2><p>{selected.description || 'Sin descripción.'}</p></div><StatusBadge>{enumLabel(taskStatuses, selected.status)}</StatusBadge></div><div className="quick-actions"><button onClick={() => openEdit(selected)}>Editar tarea</button><button onClick={() => setStatus(selected.id, 1)}>Iniciar</button><button onClick={() => setStatus(selected.id, 2, selected.blockingReason || 'Bloqueada desde ficha de tarea')}>Bloquear</button><button onClick={() => setStatus(selected.id, 3)}>Completar</button></div><KpiGrid items={[['Prioridad', enumLabel(priorities, selected.priority)], ['Vencimiento', selected.dueUtc ? dateTime.format(new Date(selected.dueUtc)) : 'Sin fecha'], ['Incidencias vinculadas', String(selectedIssues.length)], ['Intervenciones vinculadas', String(selectedInterventions.length)], ['Relaciones totales', String(taskLinks(selected.id).length)]]} /><div className="detail-grid"><Detail title="Resumen operativo" description={selected.blockingReason || 'Sin bloqueo registrado.'} rows={[['Estado', enumLabel(taskStatuses, selected.status)], ['Contacto', selected.contact?.displayName || selected.contact?.name || '-'], ['Responsable', selected.responsible || '-'], ['Vence', selected.dueUtc ? dateTime.format(new Date(selected.dueUtc)) : '-']]} /><ContextNotebookPanel projectId={projectId} entityType="Task" entityId={selected.id} entityName={selected.title} onOpenEntity={onOpenEntity} /></div><Panel title="Incidencias vinculadas">{selectedIssues.length ? <DataTable headers={['Incidencia', 'Severidad', 'Estado', 'Abrir']} rows={selectedIssues.map((issue) => [issue.title, enumLabel(severities, issue.severity), enumLabel(issueStatuses, issue.status), <button onClick={() => onOpenEntity('Issue', issue.id)}>Abrir incidencia</button>])} /> : <EmptyState title="Esta tarea aún no está vinculada a incidencias." />}</Panel><Panel title="Intervenciones vinculadas">{selectedInterventions.length ? <DataTable headers={['Intervención', 'Proveedor', 'Estado', 'Fecha', 'Abrir']} rows={selectedInterventions.map((intervention) => [intervention.title, intervention.provider?.displayName || intervention.provider?.name || '-', enumLabel(interventionStatuses, intervention.status), intervention.plannedStartUtc ? dateTime.format(new Date(intervention.plannedStartUtc)) : '-', <button onClick={() => onOpenEntity('Intervention', intervention.id)}>Abrir intervención</button>])} /> : <EmptyState title="Esta tarea aún no está vinculada a intervenciones." />}</Panel></Panel>}{!selected && <EmptyState title="Selecciona una tarea para ver su ficha y relacionarla con incidencias o intervenciones." />}<Drawer title={drawer === 'edit' ? 'Editar tarea' : 'Nueva tarea'} open={drawer !== null} onClose={() => setDrawer(null)}><form className="form-grid drawer-form" onSubmit={save}><Field label="Título"><input required value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></Field><Field label="Estado"><select value={draft.status} onChange={(e) => setDraft({ ...draft, status: Number(e.target.value) })}>{enumOptions(taskStatuses)}</select></Field><Field label="Prioridad"><select value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: Number(e.target.value) })}>{enumOptions(priorities)}</select></Field><Field label="Contacto"><select value={draft.contactId} onChange={(e) => setDraft({ ...draft, contactId: e.target.value })}><option value="">Sin contacto</option>{(contacts.data || []).map((c) => <option key={c.id} value={c.id}>{c.displayName || c.name}</option>)}</select></Field><Field label="Responsable"><input value={draft.responsible} onChange={(e) => setDraft({ ...draft, responsible: e.target.value })} /></Field><Field label="Vencimiento"><input type="datetime-local" value={draft.due} onChange={(e) => setDraft({ ...draft, due: e.target.value })} /></Field><Field label="Bloqueo"><input value={draft.blockingReason} onChange={(e) => setDraft({ ...draft, blockingReason: e.target.value })} /></Field><Field label="Descripción"><textarea value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></Field><SubmitBar><button className="primary">Guardar tarea</button></SubmitBar></form></Drawer></div>;
}

function CalendarPage({ projectId }: { projectId: number }) {
  const { data, reload } = useApi<Appointment[]>(`/api/appointments?projectId=${projectId}`, [projectId]);
  const [drawer, setDrawer] = useState<'new' | 'edit' | null>(null);
  const [editing, setEditing] = useState<Appointment | null>(null);
  const [mode, setMode] = useState<'agenda' | 'week' | 'month'>('week');
  const [cursor, setCursor] = useState(() => new Date());
  const [draft, setDraft] = useState({ title: '', start: localDateTimeValue(), end: '', location: '', participants: '', description: '', status: 0 });
  const sorted = [...(data || [])].sort((a, b) => new Date(a.startUtc).getTime() - new Date(b.startUtc).getTime());
  const startOfWeekLocal = (date: Date) => { const value = new Date(date); const day = (value.getDay() + 6) % 7; value.setDate(value.getDate() - day); value.setHours(0, 0, 0, 0); return value; };
  const sameDayLocal = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const weekStart = startOfWeekLocal(cursor);
  const weekDays = Array.from({ length: 7 }, (_, i) => { const d = new Date(weekStart); d.setDate(weekStart.getDate() + i); return d; });
  const monthGridStart = startOfWeekLocal(new Date(cursor.getFullYear(), cursor.getMonth(), 1));
  const monthDays = Array.from({ length: 42 }, (_, i) => { const d = new Date(monthGridStart); d.setDate(monthGridStart.getDate() + i); return d; });
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    const body = { projectId, title: draft.title, startUtc: toUtc(draft.start), endUtc: toUtc(draft.end), location: draft.location, participants: draft.participants, description: draft.description, status: Number(draft.status) };
    if (drawer === 'edit') {
      if (!editing) throw new Error('No se puede guardar la edición porque no hay una cita seleccionada.');
      await api.put(`/api/appointments/${editing.id}`, body);
    } else if (drawer === 'new') await api.post('/api/appointments', body);
    else throw new Error('Acción de cita no válida.');
    setDrawer(null);
    setEditing(null);
    setDraft({ title: '', start: localDateTimeValue(), end: '', location: '', participants: '', description: '', status: 0 });
    await reload();
  };
  const openEdit = (a: Appointment) => { setEditing(a); setDraft({ title: a.title, start: localDateTimeValue(new Date(a.startUtc)), end: a.endUtc ? localDateTimeValue(new Date(a.endUtc)) : '', location: a.location || '', participants: a.participants || '', description: '', status: a.status }); setDrawer('edit'); };
  const remove = async (a: Appointment) => { if (!window.confirm(`Eliminar cita "${a.title}"?`)) return; await api.delete(`/api/appointments/${a.id}`); await reload(); };
  const shift = (direction: number) => { const next = new Date(cursor); if (mode === 'month') next.setMonth(next.getMonth() + direction); else next.setDate(next.getDate() + direction * 7); setCursor(next); };
  const renderItems = (items: Appointment[]) => items.length ? items.map((a) => <article className="calendar-item" key={a.id}><b>{a.title}</b><span>{dateTime.format(new Date(a.startUtc))}</span><small>{a.location || a.participants || enumLabel(appointmentStatuses, a.status)}</small><div className="inline-actions"><button onClick={() => openEdit(a)}>Editar</button><button className="danger ghost-danger" onClick={() => remove(a)}>Eliminar</button></div></article>) : <p className="note">Sin citas.</p>;
  return <div className="page-grid"><PageHeader title="Calendario" summary="Agenda de visitas, hitos y reuniones del proyecto." action={<PrimaryAction onClick={() => setDrawer('new')}>Nueva cita</PrimaryAction>} /><Panel title="Vista calendario"><div className="toolbar calendar-toolbar"><button onClick={() => shift(-1)}>Anterior</button><button onClick={() => setCursor(new Date())}>Hoy</button><button onClick={() => shift(1)}>Siguiente</button><select value={mode} onChange={(e) => setMode(e.target.value as 'agenda' | 'week' | 'month')}><option value="agenda">Agenda</option><option value="week">Semana</option><option value="month">Mes</option></select><b>{mode === 'month' ? cursor.toLocaleDateString('es-ES', { month: 'long', year: 'numeric' }) : `${dateOnly.format(weekDays[0])} - ${dateOnly.format(weekDays[6])}`}</b></div>{mode === 'agenda' && <div className="agenda">{renderItems(sorted)}</div>}{mode === 'week' && <div className="calendar-week">{weekDays.map((day) => <section key={day.toISOString()}><h3>{day.toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric' })}</h3>{renderItems(sorted.filter((a) => sameDayLocal(new Date(a.startUtc), day)))}</section>)}</div>}{mode === 'month' && <div className="calendar-month">{monthDays.map((day) => <section key={day.toISOString()} className={day.getMonth() === cursor.getMonth() ? '' : 'muted-day'}><h3>{day.getDate()}</h3>{renderItems(sorted.filter((a) => sameDayLocal(new Date(a.startUtc), day)).slice(0, 3))}</section>)}</div>}</Panel><Drawer title={drawer === 'edit' ? 'Editar cita' : 'Nueva cita'} open={drawer !== null} onClose={() => setDrawer(null)}><form className="form-grid drawer-form" onSubmit={save}><Field label="Título"><input required value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></Field><Field label="Inicio"><input type="datetime-local" required value={draft.start} onChange={(e) => setDraft({ ...draft, start: e.target.value })} /></Field><Field label="Fin"><input type="datetime-local" value={draft.end} onChange={(e) => setDraft({ ...draft, end: e.target.value })} /></Field><Field label="Estado"><select value={draft.status} onChange={(e) => setDraft({ ...draft, status: Number(e.target.value) })}>{enumOptions(appointmentStatuses)}</select></Field><Field label="Ubicación"><input value={draft.location} onChange={(e) => setDraft({ ...draft, location: e.target.value })} /></Field><Field label="Participantes"><input value={draft.participants} onChange={(e) => setDraft({ ...draft, participants: e.target.value })} /></Field><Field label="Descripción"><textarea value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></Field><SubmitBar><button className="primary">Guardar cita</button></SubmitBar></form></Drawer></div>;
}

function InterventionsPage({ projectId, onOpenEntity }: { projectId: number; onOpenEntity: (type: string, id: number) => void }) {
  const { data, reload } = useApi<Intervention[]>(`/api/interventions?projectId=${projectId}`, [projectId]);
  const contacts = useApi<Contact[]>(`/api/contacts?projectId=${projectId}`, [projectId]);
  const tasks = useApi<Task[]>(`/api/tasks?projectId=${projectId}`, [projectId]);
  const issues = useApi<Issue[]>(`/api/issues?projectId=${projectId}`, [projectId]);
  const links = useApi<EntityLink[]>(`/api/entity-links?projectId=${projectId}`, [projectId]);
  const [filters, setFilters] = useState({ q: '', status: '', providerId: '' });
  const [drawer, setDrawer] = useState<'new' | 'edit' | null>(null);
  const [editing, setEditing] = useState<Intervention | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [draft, setDraft] = useState({ title: '', description: '', providerId: '', status: 0, plannedStart: '', expectedCost: '0', agreedCost: '0' });
  const linkedTasks = (interventionId: number) => (links.data || []).filter((link) => {
    const touchesIntervention = (link.sourceType === 'Intervention' && link.sourceId === interventionId) || (link.targetType === 'Intervention' && link.targetId === interventionId);
    const touchesTask = link.sourceType === 'Task' || link.targetType === 'Task';
    return touchesIntervention && touchesTask;
  }).map((link) => {
    const taskId = link.sourceType === 'Task' ? link.sourceId : link.targetId;
    return (tasks.data || []).find((task) => task.id === taskId);
  }).filter(Boolean) as Task[];
  const linkedIssues = (interventionId: number) => (links.data || []).filter((link) => {
    const touchesIntervention = relationTouches(link, 'Intervention', interventionId);
    const touchesIssue = link.sourceType === 'Issue' || link.targetType === 'Issue';
    return touchesIntervention && touchesIssue;
  }).map((link) => {
    const issueId = link.sourceType === 'Issue' ? link.sourceId : link.targetId;
    return (issues.data || []).find((issue) => issue.id === issueId);
  }).filter(Boolean) as Issue[];
  const selected = (data || []).find((i) => i.id === selectedId) || null;
  const selectedTasks = selected ? linkedTasks(selected.id) : [];
  const selectedIssues = selected ? linkedIssues(selected.id) : [];
  const filtered = (data || []).filter((i) => matchesSearch(filters.q, i.title, i.description, i.provider?.displayName, i.provider?.name, enumLabel(interventionStatuses, i.status)) && (!filters.status || i.status === Number(filters.status)) && (!filters.providerId || i.provider?.id === Number(filters.providerId)));
  const openEdit = (i: Intervention) => { setEditing(i); setDraft({ title: i.title, description: i.description || '', providerId: i.provider?.id ? String(i.provider.id) : '', status: i.status, plannedStart: i.plannedStartUtc ? localDateTimeValue(new Date(i.plannedStartUtc)) : '', expectedCost: String(i.expectedCost || 0), agreedCost: String(i.agreedCost || 0) }); setDrawer('edit'); };
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    const body = { projectId, title: draft.title, description: draft.description, providerId: draft.providerId ? Number(draft.providerId) : null, status: Number(draft.status), plannedStartUtc: toUtc(draft.plannedStart), expectedCost: numberValue(draft.expectedCost), agreedCost: numberValue(draft.agreedCost) };
    if (drawer === 'edit') {
      if (!editing) throw new Error('No se puede guardar la edición porque no hay una intervención seleccionada.');
      await api.put(`/api/interventions/${editing.id}`, body);
    } else if (drawer === 'new') await api.post('/api/interventions', body);
    else throw new Error('Acción de intervención no válida.');
    setDrawer(null);
    setEditing(null);
    setDraft({ title: '', description: '', providerId: '', status: 0, plannedStart: '', expectedCost: '0', agreedCost: '0' });
    await reload();
  };
  const remove = async (i: Intervention) => { if (!window.confirm(`Eliminar intervención "${i.title}"?`)) return; await api.delete(`/api/interventions/${i.id}`); await reload(); };
  const counts = interventionStatuses.map((label, status) => [label, (data || []).filter((i) => i.status === status).length] as [string, number]).filter(([, count]) => count > 0);
  return <div className="page-grid"><PageHeader title="Intervenciones" summary="Trabajos planificados, confirmados y realizados por proveedor, con tareas vinculadas visibles." action={<PrimaryAction onClick={() => setDrawer('new')}>Nueva intervención</PrimaryAction>} /><StatusSummary items={counts} /><Panel title="Listado de intervenciones"><div className="filter-bar"><input placeholder="Buscar intervención..." value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value })} /><select value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}><option value="">Todos los estados</option>{enumOptions(interventionStatuses)}</select><select value={filters.providerId} onChange={(e) => setFilters({ ...filters, providerId: e.target.value })}><option value="">Todos los proveedores</option>{(contacts.data || []).map((c) => <option key={c.id} value={c.id}>{c.displayName || c.name}</option>)}</select></div>{filtered.length ? <DataTable headers={['Trabajo', 'Proveedor', 'Estado', 'Fecha', 'Tareas vinculadas', 'Previsto', 'Acordado', 'Acciones']} rows={filtered.map((i) => {
    const relatedTasks = linkedTasks(i.id);
    return [<button className="link-button" onClick={() => setSelectedId(i.id)}>{i.title}</button>, i.provider?.displayName || i.provider?.name || '-', <StatusBadge>{enumLabel(interventionStatuses, i.status)}</StatusBadge>, i.plannedStartUtc ? dateTime.format(new Date(i.plannedStartUtc)) : '-', <div className="tag-row">{relatedTasks.length ? relatedTasks.map((task) => <button key={task.id} className="tag-link" onClick={() => onOpenEntity('Task', task.id)}>{task.title}</button>) : <span>Sin tareas</span>}</div>, euro.format(i.expectedCost || 0), euro.format(i.agreedCost || 0), <div className="inline-actions"><button onClick={() => setSelectedId(i.id)}>Abrir ficha</button><button onClick={() => openEdit(i)}>Editar</button><button className="danger ghost-danger" onClick={() => remove(i)}>Eliminar</button></div>];
  })} /> : <EmptyState title="No hay intervenciones con esos filtros." />}</Panel>{selected && <Panel><div className="entity-header"><div><span>{selected.provider?.displayName || selected.provider?.name || 'Sin proveedor'}</span><h2>{selected.title}</h2><p>{selected.description || 'Sin descripción.'}</p></div><StatusBadge>{enumLabel(interventionStatuses, selected.status)}</StatusBadge></div><div className="quick-actions"><button onClick={() => openEdit(selected)}>Editar intervención</button><button onClick={() => onOpenEntity('Contact', selected.provider?.id || 0)} disabled={!selected.provider?.id}>Abrir proveedor</button></div><KpiGrid items={[['Fecha', selected.plannedStartUtc ? dateTime.format(new Date(selected.plannedStartUtc)) : 'Sin fecha'], ['Previsto', euro.format(selected.expectedCost || 0)], ['Acordado', euro.format(selected.agreedCost || 0)], ['Tareas', String(selectedTasks.length)], ['Incidencias', String(selectedIssues.length)]]} /><div className="detail-grid"><ContextNotebookPanel projectId={projectId} entityType="Intervention" entityId={selected.id} entityName={selected.title} onOpenEntity={onOpenEntity} /><div className="relation-stack"><Panel title="Tareas vinculadas">{selectedTasks.length ? <div className="tag-row">{selectedTasks.map((task) => <button key={task.id} className="tag-link" onClick={() => onOpenEntity('Task', task.id)}>{task.title}</button>)}</div> : <EmptyState title="Sin tareas vinculadas." />}</Panel><Panel title="Incidencias vinculadas">{selectedIssues.length ? <div className="tag-row">{selectedIssues.map((issue) => <button key={issue.id} className="tag-link" onClick={() => onOpenEntity('Issue', issue.id)}>{issue.title}</button>)}</div> : <EmptyState title="Sin incidencias vinculadas." />}</Panel></div></div></Panel>}<Drawer title={drawer === 'edit' ? 'Editar intervención' : 'Nueva intervención'} open={drawer !== null} onClose={() => setDrawer(null)}><form className="form-grid drawer-form" onSubmit={save}><Field label="Trabajo"><input required value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></Field><Field label="Proveedor"><select value={draft.providerId} onChange={(e) => setDraft({ ...draft, providerId: e.target.value })}><option value="">Sin proveedor</option>{(contacts.data || []).map((c) => <option key={c.id} value={c.id}>{c.displayName || c.name}</option>)}</select></Field><Field label="Estado"><select value={draft.status} onChange={(e) => setDraft({ ...draft, status: Number(e.target.value) })}>{enumOptions(interventionStatuses)}</select></Field><Field label="Fecha prevista"><input type="datetime-local" value={draft.plannedStart} onChange={(e) => setDraft({ ...draft, plannedStart: e.target.value })} /></Field><Field label="Coste previsto"><input type="number" step="0.01" value={draft.expectedCost} onChange={(e) => setDraft({ ...draft, expectedCost: e.target.value })} /></Field><Field label="Coste acordado"><input type="number" step="0.01" value={draft.agreedCost} onChange={(e) => setDraft({ ...draft, agreedCost: e.target.value })} /></Field><Field label="Descripción"><textarea value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></Field><SubmitBar><button className="primary">Guardar intervención</button></SubmitBar></form></Drawer></div>;
}

function QuotesPage({ projectId }: { projectId: number }) {
  const requests = useApi<BudgetRequest[]>(`/api/budget-requests?projectId=${projectId}`, [projectId]);
  const quotes = useApi<Quote[]>(`/api/quotes?projectId=${projectId}`, [projectId]);
  const contacts = useApi<Contact[]>(`/api/contacts?projectId=${projectId}`, [projectId]);
  const workItems = useApi<WorkItem[]>(`/api/work-items?projectId=${projectId}`, [projectId]);
  const [filters, setFilters] = useState({ q: '', status: '', providerId: '' });
  const [drawer, setDrawer] = useState<'request' | 'editRequest' | 'quote' | 'edit' | null>(null);
  const [editing, setEditing] = useState<Quote | null>(null);
  const [editingRequest, setEditingRequest] = useState<BudgetRequest | null>(null);
  const [requestDraft, setRequestDraft] = useState({ title: '', workDescription: '', providerId: '', expectedDeadline: '', requiresVisit: true });
  const [draft, setDraft] = useState({ reference: '', providerId: '', budgetRequestId: '', validUntil: '', status: 0, discounts: '0', concept: '', description: '', quantity: '1', unit: 'ud', unitPrice: '0', taxRate: '21', category: 0, workItemId: '', optional: false, inclusionStatus: 0, notes: '', exclusions: '', paymentTerms: '', warranty: '', estimatedDuration: '' });
  const filtered = (quotes.data || []).filter((q) => matchesSearch(filters.q, q.reference, q.notes, q.provider?.displayName, q.provider?.name, enumLabel(quoteStatuses, q.status), q.lines?.map((line) => line.concept).join(' ')) && (!filters.status || q.status === Number(filters.status)) && (!filters.providerId || q.provider?.id === Number(filters.providerId)));
  const openEdit = (q: Quote) => { const line = q.lines?.[0]; setEditing(q); setDraft({ reference: q.reference, providerId: String(q.providerId || q.provider?.id || ''), budgetRequestId: q.budgetRequestId ? String(q.budgetRequestId) : '', validUntil: q.validUntilUtc ? localDateTimeValue(new Date(q.validUntilUtc)) : '', status: q.status, discounts: String(q.discounts || 0), concept: line?.concept || '', description: line?.description || '', quantity: String(line?.quantity ?? 1), unit: line?.unit || 'ud', unitPrice: String(line?.unitPrice ?? 0), taxRate: String(line?.taxRate ?? 21), category: line?.category ?? 0, workItemId: line?.workItemId ? String(line.workItemId) : '', optional: Boolean(line?.optional), inclusionStatus: line?.inclusionStatus ?? 0, notes: q.notes || '', exclusions: q.exclusions || '', paymentTerms: q.paymentTerms || '', warranty: q.warranty || '', estimatedDuration: q.estimatedDuration || '' }); setDrawer('edit'); };
  const openRequestNew = () => { setEditingRequest(null); setRequestDraft({ title: '', workDescription: '', providerId: '', expectedDeadline: '', requiresVisit: true }); setDrawer('request'); };
  const openRequestEdit = (r: BudgetRequest) => { setEditingRequest(r); setRequestDraft({ title: r.title, workDescription: r.workDescription, providerId: String(r.providerId), expectedDeadline: r.expectedDeadlineUtc ? localDateTimeValue(new Date(r.expectedDeadlineUtc)) : '', requiresVisit: Boolean(r.requiresVisit) }); setDrawer('editRequest'); };
  const saveRequest = async (event: React.FormEvent) => {
    event.preventDefault();
    const body = { projectId, title: requestDraft.title, workDescription: requestDraft.workDescription, providerId: Number(requestDraft.providerId), requestedAtUtc: editingRequest?.requestedAtUtc || new Date().toISOString(), channel: editingRequest?.channel ?? 0, expectedDeadlineUtc: toUtc(requestDraft.expectedDeadline), status: editingRequest?.status ?? 1, requiresVisit: requestDraft.requiresVisit };
    if (drawer === 'editRequest') {
      if (!editingRequest) throw new Error('No se puede guardar la edición porque no hay una solicitud seleccionada.');
      await api.put(`/api/budget-requests/${editingRequest.id}`, body);
    } else if (drawer === 'request') await api.post('/api/budget-requests', body);
    else throw new Error('Acción de solicitud no válida.');
    setEditingRequest(null);
    setRequestDraft({ title: '', workDescription: '', providerId: '', expectedDeadline: '', requiresVisit: true });
    setDrawer(null);
    await requests.reload();
  };
  const saveQuote = async (event: React.FormEvent) => {
    event.preventDefault();
    const body = { projectId, reference: draft.reference, providerId: Number(draft.providerId), issuedAtUtc: new Date().toISOString(), receivedAtUtc: new Date().toISOString(), validUntilUtc: toUtc(draft.validUntil), status: Number(draft.status), discounts: numberValue(draft.discounts), currency: 'EUR', estimatedDuration: draft.estimatedDuration, paymentTerms: draft.paymentTerms, warranty: draft.warranty, exclusions: draft.exclusions, notes: draft.notes, budgetRequestId: draft.budgetRequestId ? Number(draft.budgetRequestId) : null, lines: [{ concept: draft.concept, description: draft.description, quantity: numberValue(draft.quantity), unit: draft.unit, unitPrice: numberValue(draft.unitPrice), taxRate: numberValue(draft.taxRate), category: Number(draft.category), workItemId: draft.workItemId ? Number(draft.workItemId) : null, optional: draft.optional, inclusionStatus: Number(draft.inclusionStatus) }] };
    if (drawer === 'edit') {
      if (!editing) throw new Error('No se puede guardar la edición porque no hay un presupuesto seleccionado.');
      await api.put(`/api/quotes/${editing.id}`, body);
    } else if (drawer === 'quote') await api.post('/api/quotes', body);
    else throw new Error('Acción de presupuesto no válida.');
    setDrawer(null); setEditing(null);
    setDraft({ reference: '', providerId: '', budgetRequestId: '', validUntil: '', status: 0, discounts: '0', concept: '', description: '', quantity: '1', unit: 'ud', unitPrice: '0', taxRate: '21', category: 0, workItemId: '', optional: false, inclusionStatus: 0, notes: '', exclusions: '', paymentTerms: '', warranty: '', estimatedDuration: '' });
    await quotes.reload(); await requests.reload();
  };
  const setRequestStatus = async (id: number, status: number) => { await api.patch(`/api/budget-requests/${id}/status`, { status }); await requests.reload(); };
  const removeRequest = async (r: BudgetRequest) => { if (!window.confirm(`Eliminar solicitud "${r.title}"? Si tiene presupuestos asociados el backend lo impedirá.`)) return; await api.delete(`/api/budget-requests/${r.id}`); await requests.reload(); };
  const removeQuote = async (q: Quote) => { if (!window.confirm(`Eliminar presupuesto "${q.reference}"?`)) return; await api.delete(`/api/quotes/${q.id}`); await quotes.reload(); };
  const counts = quoteStatuses.map((label, status) => [label, (quotes.data || []).filter((q) => q.status === status).length] as [string, number]).filter(([, count]) => count > 0);
  return <div className="page-grid"><PageHeader title="Presupuestos" summary="Solicitudes enviadas, ofertas recibidas y estado de decisión." action={<><button onClick={openRequestNew}><Plus size={17} />Solicitar presupuesto</button><PrimaryAction onClick={() => setDrawer('quote')}>Registrar presupuesto</PrimaryAction></>} /><StatusSummary items={counts} /><Panel title="Presupuestos recibidos"><div className="filter-bar"><input placeholder="Buscar referencia, proveedor o notas..." value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value })} /><select value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}><option value="">Todos los estados</option>{enumOptions(quoteStatuses)}</select><select value={filters.providerId} onChange={(e) => setFilters({ ...filters, providerId: e.target.value })}><option value="">Todos los proveedores</option>{(contacts.data || []).map((c) => <option key={c.id} value={c.id}>{c.displayName || c.name}</option>)}</select></div>{filtered.length ? <DataTable headers={['Referencia', 'Proveedor', 'Estado', 'Base', 'IVA', 'Total', 'Validez', 'Acciones']} rows={filtered.map((q) => [q.reference, q.provider?.displayName || q.provider?.name || '-', <StatusBadge>{enumLabel(quoteStatuses, q.status)}</StatusBadge>, euro.format(q.subtotal), euro.format(q.taxes), euro.format(q.total), q.validUntilUtc ? dateOnly.format(new Date(q.validUntilUtc)) : '-', <div className="inline-actions"><button onClick={() => openEdit(q)}>Editar</button><button className="danger ghost-danger" onClick={() => removeQuote(q)}>Eliminar</button></div>])} /> : <EmptyState title="No hay presupuestos con esos filtros." />}</Panel><Panel title="Solicitudes abiertas"><DataTable headers={['Solicitud', 'Proveedor', 'Estado', 'Límite', 'Acciones']} rows={(requests.data || []).map((r) => [r.title, (contacts.data || []).find((c) => c.id === r.providerId)?.displayName || '-', enumLabel(budgetRequestStatuses, r.status), r.expectedDeadlineUtc ? dateTime.format(new Date(r.expectedDeadlineUtc)) : '-', <div className="inline-actions"><button onClick={() => openRequestEdit(r)}>Editar</button><button onClick={() => setRequestStatus(r.id, 2)}>Recibida</button><button onClick={() => setRequestStatus(r.id, 5)}>Sin respuesta</button><button className="danger ghost-danger" onClick={() => removeRequest(r)}>Eliminar</button></div>])} /></Panel><Drawer title={drawer === 'request' ? 'Solicitar presupuesto' : drawer === 'editRequest' ? 'Editar solicitud' : drawer === 'edit' ? 'Editar presupuesto' : 'Registrar presupuesto'} open={drawer !== null} onClose={() => setDrawer(null)}>{(drawer === 'request' || drawer === 'editRequest') ? <form className="form-grid drawer-form" onSubmit={saveRequest}><Field label="Título"><input required value={requestDraft.title} onChange={(e) => setRequestDraft({ ...requestDraft, title: e.target.value })} /></Field><Field label="Proveedor"><select required value={requestDraft.providerId} onChange={(e) => setRequestDraft({ ...requestDraft, providerId: e.target.value })}><option value="">Seleccionar</option>{(contacts.data || []).map((c) => <option key={c.id} value={c.id}>{c.displayName || c.name}</option>)}</select></Field><Field label="Límite esperado"><input type="datetime-local" value={requestDraft.expectedDeadline} onChange={(e) => setRequestDraft({ ...requestDraft, expectedDeadline: e.target.value })} /></Field><Field label="Visita previa"><span className="check-row"><input type="checkbox" checked={requestDraft.requiresVisit} onChange={(e) => setRequestDraft({ ...requestDraft, requiresVisit: e.target.checked })} />Necesaria</span></Field><Field label="Trabajo solicitado"><textarea required value={requestDraft.workDescription} onChange={(e) => setRequestDraft({ ...requestDraft, workDescription: e.target.value })} /></Field><SubmitBar><button className="primary">{drawer === 'editRequest' ? 'Guardar solicitud' : 'Crear solicitud'}</button></SubmitBar></form> : <form className="form-grid drawer-form" onSubmit={saveQuote}><Field label="Referencia"><input required value={draft.reference} onChange={(e) => setDraft({ ...draft, reference: e.target.value })} /></Field><Field label="Proveedor"><select required value={draft.providerId} onChange={(e) => setDraft({ ...draft, providerId: e.target.value })}><option value="">Seleccionar</option>{(contacts.data || []).map((c) => <option key={c.id} value={c.id}>{c.displayName || c.name}</option>)}</select></Field><Field label="Estado"><select value={draft.status} onChange={(e) => setDraft({ ...draft, status: Number(e.target.value) })}>{enumOptions(quoteStatuses)}</select></Field><Field label="Solicitud origen"><select value={draft.budgetRequestId} onChange={(e) => setDraft({ ...draft, budgetRequestId: e.target.value })}><option value="">Sin solicitud</option>{(requests.data || []).map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}</select></Field><Field label="Validez"><input type="datetime-local" value={draft.validUntil} onChange={(e) => setDraft({ ...draft, validUntil: e.target.value })} /></Field><Field label="Descuento"><input type="number" step="0.01" value={draft.discounts} onChange={(e) => setDraft({ ...draft, discounts: e.target.value })} /></Field><Field label="Concepto"><input required value={draft.concept} onChange={(e) => setDraft({ ...draft, concept: e.target.value })} /></Field><Field label="Partida"><select value={draft.workItemId} onChange={(e) => setDraft({ ...draft, workItemId: e.target.value })}><option value="">Sin partida</option>{(workItems.data || []).map((w) => <option key={w.id} value={w.id}>{w.title}</option>)}</select></Field><Field label="Cantidad"><input type="number" step="0.01" value={draft.quantity} onChange={(e) => setDraft({ ...draft, quantity: e.target.value })} /></Field><Field label="Unidad"><input value={draft.unit} onChange={(e) => setDraft({ ...draft, unit: e.target.value })} /></Field><Field label="Precio unitario"><input type="number" step="0.01" value={draft.unitPrice} onChange={(e) => setDraft({ ...draft, unitPrice: e.target.value })} /></Field><Field label="IVA %"><input type="number" step="0.01" value={draft.taxRate} onChange={(e) => setDraft({ ...draft, taxRate: e.target.value })} /></Field><Field label="Categoría"><select value={draft.category} onChange={(e) => setDraft({ ...draft, category: Number(e.target.value) })}>{enumOptions(trades)}</select></Field><Field label="Inclusión"><select value={draft.inclusionStatus} onChange={(e) => setDraft({ ...draft, inclusionStatus: Number(e.target.value) })}><option value="0">Incluida</option><option value="1">Excluida</option><option value="2">Pendiente aclaración</option></select></Field><Field label="Opcional"><span className="check-row"><input type="checkbox" checked={draft.optional} onChange={(e) => setDraft({ ...draft, optional: e.target.checked })} />Línea opcional</span></Field><Field label="Notas"><textarea value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} /></Field><Field label="Exclusiones"><textarea value={draft.exclusions} onChange={(e) => setDraft({ ...draft, exclusions: e.target.value })} /></Field><SubmitBar><button className="primary">Guardar presupuesto</button></SubmitBar></form>}</Drawer></div>;
}


function ComparisonsPage({ projectId }: { projectId: number }) {
  const { data, reload } = useApi<Comparison[]>(`/api/comparisons?projectId=${projectId}`, [projectId]);
  const quotes = useApi<Quote[]>(`/api/quotes?projectId=${projectId}`, [projectId]);
  const [drawer, setDrawer] = useState(false);
  const [draft, setDraft] = useState({ title: '', quoteIds: [] as number[], concepts: 'Demolición\nRetirada de escombros\nIVA' });
  const toggleQuote = (id: number) => setDraft((current) => ({ ...current, quoteIds: current.quoteIds.includes(id) ? current.quoteIds.filter((x) => x !== id) : [...current.quoteIds, id] }));
  const save = async (event: React.FormEvent) => { event.preventDefault(); await api.post('/api/comparisons', { projectId, title: draft.title, quoteIds: draft.quoteIds, concepts: draft.concepts.split('\n').map((x) => x.trim()).filter(Boolean) }); setDraft({ title: '', quoteIds: [], concepts: 'Demolición\nRetirada de escombros\nIVA' }); setDrawer(false); await reload(); };
  return <div className="page-grid"><PageHeader title="Comparaciones" summary="Lectura comparativa de ofertas por proveedor y conceptos obligatorios." action={<PrimaryAction onClick={() => setDrawer(true)}>Nueva comparación</PrimaryAction>} /><Panel title="Comparaciones de ofertas">{(data || []).length ? (data || []).map((c) => <article className="comparison" key={c.id}><h3>{c.title}</h3><DataTable headers={['Proveedor', 'Ref.', 'Total', 'Normalizado', 'Comparable', 'Faltan']} rows={c.entries.map((e) => [e.provider || '-', e.reference, euro.format(e.total), euro.format(e.normalizedTotal), e.comparable ? 'Sí' : 'No', e.missingRequired.join(', ') || '-'])} /></article>) : <EmptyState title="Aún no hay comparaciones." />}</Panel><Drawer title="Crear comparación" open={drawer} onClose={() => setDrawer(false)}><form className="form-grid drawer-form" onSubmit={save}><Field label="Título"><input required value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></Field><Field label="Presupuestos"><div className="check-list">{(quotes.data || []).map((q) => <label key={q.id}><input type="checkbox" checked={draft.quoteIds.includes(q.id)} onChange={() => toggleQuote(q.id)} />{q.reference} · {q.provider?.displayName || q.provider?.name || '-'} · {euro.format(q.total)}</label>)}</div></Field><Field label="Conceptos comunes"><textarea value={draft.concepts} onChange={(e) => setDraft({ ...draft, concepts: e.target.value })} /></Field><SubmitBar><button className="primary" disabled={draft.quoteIds.length < 2}>Crear comparación</button></SubmitBar></form></Drawer></div>;
}

function EconomyPage() {
  const { data } = useApi<Dashboard>('/api/dashboard', []);
  if (!data) return <Panel>Cargando economía...</Panel>;
  const items = Object.entries(data.economy).map(([key, value]) => {
    if (key === 'deviationPercent') return [economyLabels[key], `${Number(value).toLocaleString('es-ES', { maximumFractionDigits: 2 })} %`] as [string, string];
    if (key === 'deviation') return [Number(value) <= 0 ? 'Margen disponible' : 'Desviación sobre objetivo', euro.format(Math.abs(Number(value)))] as [string, string];
    return [economyLabels[key] || key, typeof value === 'number' ? euro.format(value) : String(value)] as [string, string];
  });
  return <div className="page-grid"><PageHeader title="Resumen económico" summary="Situación presupuestaria, comprometida, facturada y pagada del proyecto." /><KpiGrid items={items} /><Panel title="Regla de lectura"><p className="note">La previsión final toma el mayor dato conocido entre estimado, comprometido y facturado. Comprometido y facturado son señales independientes: si una factura supera lo aceptado, la previsión sube al importe facturado.</p></Panel></div>;
}

function InvoicesPage({ projectId }: { projectId: number }) {
  const { data, reload } = useApi<InvoiceRow[]>(`/api/invoices?projectId=${projectId}`, [projectId]);
  const contacts = useApi<Contact[]>(`/api/contacts?projectId=${projectId}`, [projectId]);
  const quotes = useApi<Quote[]>(`/api/quotes?projectId=${projectId}`, [projectId]);
  const [drawer, setDrawer] = useState<'invoice' | 'editInvoice' | 'payment' | 'editPayment' | null>(null);
  const [editingInvoice, setEditingInvoice] = useState<InvoiceRow | null>(null);
  const [editingPayment, setEditingPayment] = useState<Payment | null>(null);
  const [error, setError] = useState('');
  const [invoice, setInvoice] = useState({ number: '', supplierId: '', status: 0, dueDate: '', quoteId: '', concept: '', quantity: '1', unitPrice: '0', taxRate: '21', notes: '' });
  const [payment, setPayment] = useState({ invoiceId: '', paidAt: localDateTimeValue(), amount: '0', method: 0, reference: '', notes: '' });
  const openInvoiceEdit = (row: InvoiceRow) => { const line = row.invoice.lines?.[0]; setError(''); setEditingInvoice(row); setInvoice({ number: row.invoice.number, supplierId: String(row.invoice.supplierId || row.invoice.supplier?.id || ''), status: row.invoice.status, dueDate: row.invoice.dueDateUtc ? localDateTimeValue(new Date(row.invoice.dueDateUtc)) : '', quoteId: row.invoice.quoteId ? String(row.invoice.quoteId) : '', concept: line?.concept || '', quantity: String(line?.quantity ?? 1), unitPrice: String(line?.unitPrice ?? row.invoice.total), taxRate: String(line?.taxRate ?? 21), notes: row.invoice.notes || '' }); setDrawer('editInvoice'); };
  const saveInvoice = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    try {
      const body = { projectId, number: invoice.number, supplierId: Number(invoice.supplierId), issueDateUtc: new Date().toISOString(), receivedAtUtc: new Date().toISOString(), dueDateUtc: toUtc(invoice.dueDate), status: Number(invoice.status), quoteId: invoice.quoteId ? Number(invoice.quoteId) : null, notes: invoice.notes, lines: [{ concept: invoice.concept, quantity: numberValue(invoice.quantity), unitPrice: numberValue(invoice.unitPrice), taxRate: numberValue(invoice.taxRate) }] };
      if (drawer === 'editInvoice') {
        if (!editingInvoice) throw new Error('No se puede guardar la edición porque no hay una factura seleccionada.');
        await api.put(`/api/invoices/${editingInvoice.invoice.id}`, body);
      } else if (drawer === 'invoice') await api.post('/api/invoices', body);
      else throw new Error('Acción de factura no válida.');
      setDrawer(null); setEditingInvoice(null); setInvoice({ number: '', supplierId: '', status: 0, dueDate: '', quoteId: '', concept: '', quantity: '1', unitPrice: '0', taxRate: '21', notes: '' }); await reload();
    } catch (err) { setError(err instanceof Error ? err.message : 'No se pudo guardar la factura'); }
  };
  const openPaymentEdit = (p: Payment) => { setError(''); setEditingPayment(p); setPayment({ invoiceId: String(p.invoiceId), paidAt: localDateTimeValue(new Date(p.paidAtUtc)), amount: String(p.amount), method: p.method, reference: p.reference || '', notes: p.notes || '' }); setDrawer('editPayment'); };
  const savePayment = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    try {
      const body = { invoiceId: Number(payment.invoiceId), paidAtUtc: toUtc(payment.paidAt), amount: numberValue(payment.amount), method: Number(payment.method), reference: payment.reference, notes: payment.notes };
      if (drawer === 'editPayment') {
        if (!editingPayment) throw new Error('No se puede guardar la edición porque no hay un pago seleccionado.');
        await api.put(`/api/payments/${editingPayment.id}`, body);
      } else if (drawer === 'payment') await api.post('/api/payments', body);
      else throw new Error('Acción de pago no válida.');
      setDrawer(null); setEditingPayment(null); setPayment({ invoiceId: '', paidAt: localDateTimeValue(), amount: '0', method: 0, reference: '', notes: '' }); await reload();
    } catch (err) { setError(err instanceof Error ? err.message : 'No se pudo guardar el pago'); }
  };
  const removeInvoice = async (row: InvoiceRow) => { if (!window.confirm(`Eliminar factura "${row.invoice.number}"?`)) return; await api.delete(`/api/invoices/${row.invoice.id}`); await reload(); };
  const removePayment = async (p: Payment) => { if (!window.confirm(`Eliminar pago "${p.reference || euro.format(p.amount)}"?`)) return; await api.delete(`/api/payments/${p.id}`); await reload(); };
  return <div className="page-grid"><PageHeader title="Facturas y pagos" summary="Control de facturas, vencimientos, saldos y pagos registrados." action={<><button onClick={() => { setError(''); setDrawer('payment'); }}><Plus size={17} />Registrar pago</button><PrimaryAction onClick={() => { setError(''); setDrawer('invoice'); }}>Registrar factura</PrimaryAction></>} /><KpiGrid items={[['Facturado', euro.format((data || []).reduce((s, r) => s + r.balance.total, 0))], ['Pagado', euro.format((data || []).reduce((s, r) => s + r.balance.paid, 0))], ['Pendiente', euro.format((data || []).reduce((s, r) => s + r.balance.pending, 0))], ['Vencidas', String((data || []).filter((r) => r.balance.overdue).length)]]} /><Panel title="Facturas"><DataTable headers={['Factura', 'Proveedor', 'Estado', 'Total', 'Pagado', 'Pendiente', 'Vencimiento', 'Pagos', 'Acciones']} rows={(data || []).map((r) => [r.invoice.number, r.invoice.supplier?.displayName || r.invoice.supplier?.name || '-', <StatusBadge>{enumLabel(invoiceStatuses, r.invoice.status)}</StatusBadge>, euro.format(r.balance.total), euro.format(r.balance.paid), euro.format(r.balance.pending), r.invoice.dueDateUtc ? dateOnly.format(new Date(r.invoice.dueDateUtc)) : '-', <div className="mini-list">{(r.invoice.payments || []).map((p) => <span key={p.id}>{euro.format(p.amount)} · {p.reference || enumLabel(paymentMethods, p.method)} <button onClick={() => openPaymentEdit(p)}>Editar</button><button className="danger ghost-danger" onClick={() => removePayment(p)}>Borrar</button></span>)}</div>, <div className="inline-actions"><button onClick={() => openInvoiceEdit(r)}>Editar</button><button className="danger ghost-danger" onClick={() => removeInvoice(r)}>Eliminar</button></div>])} /></Panel><Drawer title={drawer === 'payment' || drawer === 'editPayment' ? 'Registrar pago' : 'Registrar factura'} open={drawer !== null} onClose={() => { setDrawer(null); setError(''); }}>{drawer === 'payment' || drawer === 'editPayment' ? <form className="form-grid drawer-form" onSubmit={savePayment}><Field label="Factura"><select required value={payment.invoiceId} onChange={(e) => setPayment({ ...payment, invoiceId: e.target.value })}><option value="">Seleccionar</option>{(data || []).map((r) => <option key={r.invoice.id} value={r.invoice.id}>{r.invoice.number} · pendiente {euro.format(r.balance.pending)}</option>)}</select></Field><Field label="Fecha pago"><input type="datetime-local" required value={payment.paidAt} onChange={(e) => setPayment({ ...payment, paidAt: e.target.value })} /></Field><Field label="Importe"><input type="number" step="0.01" value={payment.amount} onChange={(e) => setPayment({ ...payment, amount: e.target.value })} /></Field><Field label="Método"><select value={payment.method} onChange={(e) => setPayment({ ...payment, method: Number(e.target.value) })}>{enumOptions(paymentMethods)}</select></Field><Field label="Referencia"><input value={payment.reference} onChange={(e) => setPayment({ ...payment, reference: e.target.value })} /></Field><Field label="Notas"><textarea value={payment.notes} onChange={(e) => setPayment({ ...payment, notes: e.target.value })} /></Field><SubmitBar error={error}><button className="primary">Guardar pago</button></SubmitBar></form> : <form className="form-grid drawer-form" onSubmit={saveInvoice}><Field label="Número"><input required value={invoice.number} onChange={(e) => setInvoice({ ...invoice, number: e.target.value })} /></Field><Field label="Proveedor"><select required value={invoice.supplierId} onChange={(e) => setInvoice({ ...invoice, supplierId: e.target.value })}><option value="">Seleccionar</option>{(contacts.data || []).map((c) => <option key={c.id} value={c.id}>{c.displayName || c.name}</option>)}</select></Field><Field label="Estado"><select value={invoice.status} onChange={(e) => setInvoice({ ...invoice, status: Number(e.target.value) })}>{enumOptions(invoiceStatuses)}</select></Field><Field label="Presupuesto relacionado"><select value={invoice.quoteId} onChange={(e) => setInvoice({ ...invoice, quoteId: e.target.value })}><option value="">Sin presupuesto</option>{(quotes.data || []).map((q) => <option key={q.id} value={q.id}>{q.reference}</option>)}</select></Field><Field label="Vencimiento"><input type="datetime-local" value={invoice.dueDate} onChange={(e) => setInvoice({ ...invoice, dueDate: e.target.value })} /></Field><Field label="Concepto línea"><input required value={invoice.concept} onChange={(e) => setInvoice({ ...invoice, concept: e.target.value })} /></Field><Field label="Cantidad"><input type="number" step="0.01" value={invoice.quantity} onChange={(e) => setInvoice({ ...invoice, quantity: e.target.value })} /></Field><Field label="Precio unitario"><input type="number" step="0.01" value={invoice.unitPrice} onChange={(e) => setInvoice({ ...invoice, unitPrice: e.target.value })} /></Field><Field label="IVA %"><input type="number" step="0.01" value={invoice.taxRate} onChange={(e) => setInvoice({ ...invoice, taxRate: e.target.value })} /></Field><Field label="Notas"><textarea value={invoice.notes} onChange={(e) => setInvoice({ ...invoice, notes: e.target.value })} /></Field><SubmitBar error={error}><button className="primary">Guardar factura</button></SubmitBar></form>}</Drawer></div>;
}

function DocumentsPage({ projectId }: { projectId: number }) {
  const { data, reload } = useApi<DocumentRow[]>(`/api/documents?projectId=${projectId}`, [projectId]);
  const [drawer, setDrawer] = useState<'upload' | 'edit' | null>(null);
  const [editing, setEditing] = useState<DocumentRow | null>(null);
  const [meta, setMeta] = useState({ title: '', type: 11, description: '' });
  const [file, setFile] = useState<File | null>(null);
  const [filters, setFilters] = useState({ q: '', type: '' });
  const apiTypes = ['Plan', 'Quote', 'Invoice', 'PaymentProof', 'Contract', 'License', 'Certificate', 'ElectricalBulletin', 'Photo', 'Report', 'Communication', 'Other'];
  const filtered = (data || []).filter((d) => matchesSearch(filters.q, d.title, d.originalFileName, enumLabel(documentTypes, d.type), d.mimeType) && (!filters.type || d.type === Number(filters.type)));
  const upload = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!file) return;
    const form = new FormData();
    form.append('projectId', String(projectId));
    form.append('type', apiTypes[Number(meta.type)]);
    form.append('title', meta.title || file.name);
    form.append('description', meta.description);
    form.append('file', file);
    await api.post('/api/documents', form);
    setFile(null); setMeta({ title: '', type: 11, description: '' }); setDrawer(null); await reload();
  };
  const openEdit = (d: DocumentRow) => { setEditing(d); setMeta({ title: d.title, type: d.type, description: '' }); setDrawer('edit'); };
  const saveEdit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!editing) return;
    await api.put(`/api/documents/${editing.id}`, { title: meta.title, description: meta.description, type: Number(meta.type) });
    setEditing(null); setMeta({ title: '', type: 11, description: '' }); setDrawer(null); await reload();
  };
  const remove = async (d: DocumentRow) => { if (!window.confirm(`Archivar documento "${d.title}"?`)) return; await api.delete(`/api/documents/${d.id}`); await reload(); };
  const counts = documentTypes.map((label, type) => [label, (data || []).filter((d) => d.type === type).length] as [string, number]).filter(([, count]) => count > 0);
  return <div className="page-grid"><PageHeader title="Documentos" summary="Repositorio de presupuestos, facturas, planos, fotos y evidencias." action={<PrimaryAction onClick={() => setDrawer('upload')}>Subir documento</PrimaryAction>} /><StatusSummary items={counts} /><Panel title="Gestor documental"><div className="filter-bar"><input placeholder="Buscar documento..." value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value })} /><select value={filters.type} onChange={(e) => setFilters({ ...filters, type: e.target.value })}><option value="">Todos los tipos</option>{enumOptions(documentTypes)}</select></div>{filtered.length ? <DataTable headers={['Título', 'Tipo', 'Archivo', 'MIME', 'Tamaño', 'Subido', 'Acciones']} rows={filtered.map((d) => [d.title, enumLabel(documentTypes, d.type), d.originalFileName, d.mimeType, `${Math.round(d.sizeBytes / 1024)} KB`, dateTime.format(new Date(d.uploadedAtUtc)), <div className="inline-actions"><a href={`/api/documents/${d.id}/download`}>Descargar</a><button onClick={() => openEdit(d)}>Editar</button><button className="danger ghost-danger" onClick={() => remove(d)}>Archivar</button></div>])} /> : <EmptyState title="No hay documentos con esos filtros." />}</Panel><Drawer title={drawer === 'edit' ? 'Editar documento' : 'Subir documento'} open={drawer !== null} onClose={() => setDrawer(null)}>{drawer === 'edit' ? <form className="form-grid drawer-form" onSubmit={saveEdit}><Field label="Título visible"><input required value={meta.title} onChange={(e) => setMeta({ ...meta, title: e.target.value })} /></Field><Field label="Tipo"><select value={meta.type} onChange={(e) => setMeta({ ...meta, type: Number(e.target.value) })}>{enumOptions(documentTypes)}</select></Field><Field label="Descripción"><textarea value={meta.description} onChange={(e) => setMeta({ ...meta, description: e.target.value })} /></Field><SubmitBar><button className="primary">Guardar metadatos</button></SubmitBar></form> : <form className="form-grid drawer-form" onSubmit={upload}><Field label="Archivo"><input required type="file" onChange={(e) => setFile(e.target.files?.[0] || null)} /></Field><Field label="Título visible"><input value={meta.title} onChange={(e) => setMeta({ ...meta, title: e.target.value })} /></Field><Field label="Tipo"><select value={meta.type} onChange={(e) => setMeta({ ...meta, type: Number(e.target.value) })}>{enumOptions(documentTypes)}</select></Field><Field label="Descripción"><textarea value={meta.description} onChange={(e) => setMeta({ ...meta, description: e.target.value })} /></Field><SubmitBar><button className="primary"><Upload size={17} />Subir</button></SubmitBar></form>}</Drawer></div>;
}

function AlertsPage({ projectId, onOpenEntity }: { projectId: number; onOpenEntity: (type: string, id: number) => void }) {
  const alerts = useApi<Alert[]>(`/api/alerts?projectId=${projectId}`, [projectId]);
  const contacts = useApi<Contact[]>(`/api/contacts?projectId=${projectId}`, [projectId]);
  const issues = useApi<Issue[]>(`/api/issues?projectId=${projectId}`, [projectId]);
  const reqs = useApi<Requirement[]>(`/api/requirements?projectId=${projectId}`, [projectId]);
  const decisions = useApi<Decision[]>(`/api/decisions?projectId=${projectId}`, [projectId]);
  const tasks = useApi<Task[]>(`/api/tasks?projectId=${projectId}`, [projectId]);
  const interventions = useApi<Intervention[]>(`/api/interventions?projectId=${projectId}`, [projectId]);
  const links = useApi<EntityLink[]>(`/api/entity-links?projectId=${projectId}`, [projectId]);
  const [tab, setTab] = useState<'alerts' | 'issues' | 'requirements' | 'decisions'>('alerts');
  const [drawer, setDrawer] = useState<'issue' | 'requirement' | 'decision' | null>(null);
  const [editing, setEditing] = useState<{ type: 'issue' | 'requirement' | 'decision'; id: number } | null>(null);
  const [selectedIssueId, setSelectedIssueId] = useState<number | null>(null);
  const [selectedRequirementId, setSelectedRequirementId] = useState<number | null>(null);
  const [selectedDecisionId, setSelectedDecisionId] = useState<number | null>(null);
  const [filters, setFilters] = useState({ q: '', state: '', kind: '' });
  const [issue, setIssue] = useState({ title: '', description: '', severity: 1, status: 0, detectedByContactId: '', knownCause: '', proposedSolution: '', appliedSolution: '' });
  const [req, setReq] = useState({ text: '', type: 1, justification: '', communicatedToContactId: '', complianceStatus: 0 });
  const [decision, setDecision] = useState({ title: '', decisionText: '', reason: '', alternatives: '', economicImpact: '0' });
  const resetDrawer = () => { setDrawer(null); setEditing(null); };
  const openNew = (kind: 'issue' | 'requirement' | 'decision') => {
    setEditing(null);
    if (kind === 'issue') { setIssue({ title: '', description: '', severity: 1, status: 0, detectedByContactId: '', knownCause: '', proposedSolution: '', appliedSolution: '' }); setDrawer('issue'); }
    if (kind === 'requirement') { setReq({ text: '', type: 1, justification: '', communicatedToContactId: '', complianceStatus: 0 }); setDrawer('requirement'); }
    if (kind === 'decision') { setDecision({ title: '', decisionText: '', reason: '', alternatives: '', economicImpact: '0' }); setDrawer('decision'); }
  };
  const openIssueEdit = (x: Issue) => { setEditing({ type: 'issue', id: x.id }); setSelectedIssueId(x.id); setIssue({ title: x.title, description: x.description || '', severity: x.severity, status: x.status, detectedByContactId: x.detectedByContactId ? String(x.detectedByContactId) : '', knownCause: x.knownCause || '', proposedSolution: x.proposedSolution || '', appliedSolution: x.appliedSolution || '' }); setDrawer('issue'); };
  const openReqEdit = (x: Requirement) => { setEditing({ type: 'requirement', id: x.id }); setSelectedRequirementId(x.id); setReq({ text: x.text, type: x.type, justification: x.justification || '', communicatedToContactId: x.communicatedToContactId ? String(x.communicatedToContactId) : '', complianceStatus: x.complianceStatus }); setDrawer('requirement'); };
  const openDecisionEdit = (x: Decision) => { setEditing({ type: 'decision', id: x.id }); setSelectedDecisionId(x.id); setDecision({ title: x.title, decisionText: x.decisionText, reason: x.reason || '', alternatives: x.alternatives || '', economicImpact: String(x.economicImpact || 0) }); setDrawer('decision'); };
  const saveIssue = async (event: React.FormEvent) => {
    event.preventDefault();
    const body = { projectId, title: issue.title, description: issue.description, severity: Number(issue.severity), status: Number(issue.status), detectedAtUtc: new Date().toISOString(), detectedByContactId: issue.detectedByContactId ? Number(issue.detectedByContactId) : null, knownCause: issue.knownCause, proposedSolution: issue.proposedSolution, appliedSolution: issue.appliedSolution };
    if (editing?.type === 'issue') await api.put(`/api/issues/${editing.id}`, body);
    else { const created = await api.post<Issue>('/api/issues', body); setSelectedIssueId(created.id); }
    resetDrawer();
    await issues.reload();
  };
  const saveReq = async (event: React.FormEvent) => {
    event.preventDefault();
    const body = { projectId, text: req.text, type: Number(req.type), justification: req.justification, communicatedToContactId: req.communicatedToContactId ? Number(req.communicatedToContactId) : null, communicatedAtUtc: req.communicatedToContactId ? new Date().toISOString() : null, complianceStatus: Number(req.complianceStatus) };
    if (editing?.type === 'requirement') await api.put(`/api/requirements/${editing.id}`, body);
    else { const created = await api.post<Requirement>('/api/requirements', body); setSelectedRequirementId(created.id); }
    resetDrawer();
    await reqs.reload();
  };
  const saveDecision = async (event: React.FormEvent) => {
    event.preventDefault();
    const body = { projectId, title: decision.title, decisionText: decision.decisionText, decidedAtUtc: new Date().toISOString(), reason: decision.reason, alternatives: decision.alternatives, economicImpact: numberValue(decision.economicImpact) };
    if (editing?.type === 'decision') await api.put(`/api/decisions/${editing.id}`, body);
    else { const created = await api.post<Decision>('/api/decisions', body); setSelectedDecisionId(created.id); }
    resetDrawer();
    await decisions.reload();
  };
  const removeIssue = async (x: Issue) => { if (!window.confirm(`Eliminar incidencia "${x.title}"?`)) return; await api.delete(`/api/issues/${x.id}`); if (selectedIssueId === x.id) setSelectedIssueId(null); await issues.reload(); };
  const removeReq = async (x: Requirement) => { if (!window.confirm('Eliminar este requisito?')) return; await api.delete(`/api/requirements/${x.id}`); if (selectedRequirementId === x.id) setSelectedRequirementId(null); await reqs.reload(); };
  const removeDecision = async (x: Decision) => { if (!window.confirm(`Eliminar decisión "${x.title}"?`)) return; await api.delete(`/api/decisions/${x.id}`); if (selectedDecisionId === x.id) setSelectedDecisionId(null); await decisions.reload(); };
  const issueLinked = (issueId: number, type: 'Task' | 'Intervention') => (links.data || []).filter((link) => {
    const touchesIssue = relationTouches(link, 'Issue', issueId);
    return touchesIssue && (link.sourceType === type || link.targetType === type);
  }).map((link) => {
    const id = link.sourceType === type ? link.sourceId : link.targetId;
    return type === 'Task' ? (tasks.data || []).find((task) => task.id === id) : (interventions.data || []).find((intervention) => intervention.id === id);
  }).filter(Boolean) as Array<Task | Intervention>;
  const filteredIssues = (issues.data || []).filter((x) => matchesSearch(filters.q, x.title, x.description, x.knownCause, x.proposedSolution, x.appliedSolution, enumLabel(issueStatuses, x.status), enumLabel(severities, x.severity)) && (!filters.state || x.status === Number(filters.state)) && (!filters.kind || x.severity === Number(filters.kind)));
  const filteredReqs = (reqs.data || []).filter((x) => matchesSearch(filters.q, x.text, x.justification, enumLabel(complianceStatuses, x.complianceStatus), enumLabel(requirementTypes, x.type)) && (!filters.state || x.complianceStatus === Number(filters.state)) && (!filters.kind || x.type === Number(filters.kind)));
  const filteredDecisions = (decisions.data || []).filter((x) => matchesSearch(filters.q, x.title, x.decisionText, x.reason, x.alternatives));
  const selectedIssue = (issues.data || []).find((x) => x.id === selectedIssueId) || null;
  const selectedRequirement = (reqs.data || []).find((x) => x.id === selectedRequirementId) || null;
  const selectedDecision = (decisions.data || []).find((x) => x.id === selectedDecisionId) || null;
  const selectedIssueTasks = selectedIssue ? issueLinked(selectedIssue.id, 'Task') as Task[] : [];
  const selectedIssueInterventions = selectedIssue ? issueLinked(selectedIssue.id, 'Intervention') as Intervention[] : [];
  const resetFilters = (nextTab: typeof tab) => { setTab(nextTab); setFilters({ q: '', state: '', kind: '' }); };
  return <div className="page-grid"><PageHeader title="Seguimiento" summary="Control CRUD de alertas, incidencias, requisitos y decisiones con detalle contextual." action={<><button onClick={() => openNew('issue')}><Plus size={17} />Incidencia</button><button onClick={() => openNew('requirement')}><Plus size={17} />Requisito</button><button onClick={() => openNew('decision')}><Plus size={17} />Decisión</button></>} /><Tabs tabs={[{ id: 'alerts', label: 'Alertas' }, { id: 'issues', label: 'Incidencias' }, { id: 'requirements', label: 'Requisitos' }, { id: 'decisions', label: 'Decisiones' }]} active={tab} onChange={resetFilters} /><Panel title={tab === 'alerts' ? 'Alertas activas' : tab === 'issues' ? 'Incidencias' : tab === 'requirements' ? 'Requisitos' : 'Decisiones'}>{tab !== 'alerts' && <div className="filter-bar followup-filters"><input placeholder="Buscar..." value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value })} />{tab === 'issues' && <><select value={filters.state} onChange={(e) => setFilters({ ...filters, state: e.target.value })}><option value="">Todos los estados</option>{enumOptions(issueStatuses)}</select><select value={filters.kind} onChange={(e) => setFilters({ ...filters, kind: e.target.value })}><option value="">Todas las severidades</option>{enumOptions(severities)}</select></>}{tab === 'requirements' && <><select value={filters.state} onChange={(e) => setFilters({ ...filters, state: e.target.value })}><option value="">Todos los cumplimientos</option>{enumOptions(complianceStatuses)}</select><select value={filters.kind} onChange={(e) => setFilters({ ...filters, kind: e.target.value })}><option value="">Todos los tipos</option>{enumOptions(requirementTypes)}</select></>}{tab === 'decisions' && <><span className="note">Las decisiones se filtran por título, texto y motivo.</span></>}</div>}{tab === 'alerts' && <AlertList alerts={alerts.data || []} onOpenEntity={onOpenEntity} />}{tab === 'issues' && (filteredIssues.length ? <DataTable headers={['Incidencia', 'Severidad', 'Estado', 'Vínculos', 'Acciones']} rows={filteredIssues.map((x) => {
    const relatedTasks = issueLinked(x.id, 'Task') as Task[];
    const relatedInterventions = issueLinked(x.id, 'Intervention') as Intervention[];
    return [<button className="link-button" onClick={() => setSelectedIssueId(x.id)}>{x.title}</button>, enumLabel(severities, x.severity), <StatusBadge>{enumLabel(issueStatuses, x.status)}</StatusBadge>, <div className="tag-row">{relatedTasks.length ? <span>Tareas {relatedTasks.length}</span> : null}{relatedInterventions.length ? <span>Intervenciones {relatedInterventions.length}</span> : null}{!relatedTasks.length && !relatedInterventions.length && <span>Sin vínculos</span>}</div>, <div className="inline-actions"><button onClick={() => setSelectedIssueId(x.id)}>Abrir</button><button onClick={() => openIssueEdit(x)}>Editar</button><button className="danger ghost-danger" onClick={() => removeIssue(x)}>Eliminar</button></div>];
  })} /> : <EmptyState title="No hay incidencias con esos filtros." action={<button onClick={() => openNew('issue')}>Crear incidencia</button>} />)}{tab === 'requirements' && (filteredReqs.length ? <DataTable headers={['Requisito', 'Tipo', 'Cumplimiento', 'Acciones']} rows={filteredReqs.map((x) => [<button className="link-button" onClick={() => setSelectedRequirementId(x.id)}>{x.text}</button>, enumLabel(requirementTypes, x.type), <StatusBadge>{enumLabel(complianceStatuses, x.complianceStatus)}</StatusBadge>, <div className="inline-actions"><button onClick={() => setSelectedRequirementId(x.id)}>Abrir</button><button onClick={() => openReqEdit(x)}>Editar</button><button className="danger ghost-danger" onClick={() => removeReq(x)}>Eliminar</button></div>])} /> : <EmptyState title="No hay requisitos con esos filtros." action={<button onClick={() => openNew('requirement')}>Crear requisito</button>} />)}{tab === 'decisions' && (filteredDecisions.length ? <DataTable headers={['Decisión', 'Texto', 'Impacto', 'Acciones']} rows={filteredDecisions.map((x) => [<button className="link-button" onClick={() => setSelectedDecisionId(x.id)}>{x.title}</button>, x.decisionText, x.economicImpact ? euro.format(x.economicImpact) : '-', <div className="inline-actions"><button onClick={() => setSelectedDecisionId(x.id)}>Abrir</button><button onClick={() => openDecisionEdit(x)}>Editar</button><button className="danger ghost-danger" onClick={() => removeDecision(x)}>Eliminar</button></div>])} /> : <EmptyState title="No hay decisiones con esos filtros." action={<button onClick={() => openNew('decision')}>Crear decisión</button>} />)}</Panel>{tab === 'issues' && selectedIssue && <Panel><div className="entity-header"><div><span>{enumLabel(severities, selectedIssue.severity)}</span><h2>{selectedIssue.title}</h2><p>{selectedIssue.description || 'Sin descripción.'}</p></div><div className="inline-actions"><StatusBadge>{enumLabel(issueStatuses, selectedIssue.status)}</StatusBadge><button onClick={() => openIssueEdit(selectedIssue)}>Editar</button></div></div><KpiGrid items={[['Tareas', String(selectedIssueTasks.length)], ['Intervenciones', String(selectedIssueInterventions.length)], ['Relaciones', String((links.data || []).filter((link) => relationTouches(link, 'Issue', selectedIssue.id)).length)]]} /><div className="detail-grid"><ContextNotebookPanel projectId={projectId} entityType="Issue" entityId={selectedIssue.id} entityName={selectedIssue.title} onOpenEntity={onOpenEntity} /><div className="relation-stack"><Detail title="Diagnóstico" rows={[['Causa conocida', selectedIssue.knownCause || '-'], ['Solución propuesta', selectedIssue.proposedSolution || '-'], ['Solución aplicada', selectedIssue.appliedSolution || '-']]} /><Panel title="Tareas vinculadas">{selectedIssueTasks.length ? <div className="tag-row">{selectedIssueTasks.map((task) => <button key={task.id} className="tag-link" onClick={() => onOpenEntity('Task', task.id)}>{task.title}</button>)}</div> : <EmptyState title="Sin tareas vinculadas." />}</Panel><Panel title="Intervenciones vinculadas">{selectedIssueInterventions.length ? <div className="tag-row">{selectedIssueInterventions.map((intervention) => <button key={intervention.id} className="tag-link" onClick={() => onOpenEntity('Intervention', intervention.id)}>{intervention.title}</button>)}</div> : <EmptyState title="Sin intervenciones vinculadas." />}</Panel></div></div></Panel>}{tab === 'requirements' && selectedRequirement && <Panel><div className="entity-header"><div><span>{enumLabel(requirementTypes, selectedRequirement.type)}</span><h2>Requisito</h2><p>{selectedRequirement.text}</p></div><div className="inline-actions"><StatusBadge>{enumLabel(complianceStatuses, selectedRequirement.complianceStatus)}</StatusBadge><button onClick={() => openReqEdit(selectedRequirement)}>Editar</button></div></div><Detail title="Contexto del requisito" description={selectedRequirement.justification || 'Sin justificación registrada.'} rows={[['Comunicado', selectedRequirement.communicatedAtUtc ? dateTime.format(new Date(selectedRequirement.communicatedAtUtc)) : '-'], ['Contacto', selectedRequirement.communicatedToContactId ? (contacts.data || []).find((c) => c.id === selectedRequirement.communicatedToContactId)?.displayName || String(selectedRequirement.communicatedToContactId) : '-']]} /><ContextNotebookPanel projectId={projectId} entityType="Requirement" entityId={selectedRequirement.id} entityName={selectedRequirement.text} onOpenEntity={onOpenEntity} /></Panel>}{tab === 'decisions' && selectedDecision && <Panel><div className="entity-header"><div><span>{selectedDecision.decidedAtUtc ? dateOnly.format(new Date(selectedDecision.decidedAtUtc)) : 'Sin fecha'}</span><h2>{selectedDecision.title}</h2><p>{selectedDecision.decisionText}</p></div><div className="inline-actions"><StatusBadge>{selectedDecision.economicImpact ? euro.format(selectedDecision.economicImpact) : 'Sin impacto'}</StatusBadge><button onClick={() => openDecisionEdit(selectedDecision)}>Editar</button></div></div><Detail title="Motivo y alternativas" description={selectedDecision.reason || 'Sin motivo registrado.'} rows={[['Alternativas', selectedDecision.alternatives || '-'], ['Impacto económico', selectedDecision.economicImpact ? euro.format(selectedDecision.economicImpact) : '-']]} /><ContextNotebookPanel projectId={projectId} entityType="Decision" entityId={selectedDecision.id} entityName={selectedDecision.title} onOpenEntity={onOpenEntity} /></Panel>}<Drawer title={drawer === 'issue' ? editing?.type === 'issue' ? 'Editar incidencia' : 'Nueva incidencia' : drawer === 'requirement' ? editing?.type === 'requirement' ? 'Editar requisito' : 'Nuevo requisito' : editing?.type === 'decision' ? 'Editar decisión' : 'Nueva decisión'} open={drawer !== null} onClose={resetDrawer}>{drawer === 'issue' && <form className="form-grid drawer-form" onSubmit={saveIssue}><Field label="Título"><input required value={issue.title} onChange={(e) => setIssue({ ...issue, title: e.target.value })} /></Field><Field label="Severidad"><select value={issue.severity} onChange={(e) => setIssue({ ...issue, severity: Number(e.target.value) })}>{enumOptions(severities)}</select></Field><Field label="Estado"><select value={issue.status} onChange={(e) => setIssue({ ...issue, status: Number(e.target.value) })}>{enumOptions(issueStatuses)}</select></Field><Field label="Detectada por"><select value={issue.detectedByContactId} onChange={(e) => setIssue({ ...issue, detectedByContactId: e.target.value })}><option value="">Sin contacto</option>{(contacts.data || []).map((c) => <option key={c.id} value={c.id}>{c.displayName || c.name}</option>)}</select></Field><Field label="Descripción"><textarea value={issue.description} onChange={(e) => setIssue({ ...issue, description: e.target.value })} /></Field><Field label="Causa conocida"><textarea value={issue.knownCause} onChange={(e) => setIssue({ ...issue, knownCause: e.target.value })} /></Field><Field label="Solución propuesta"><textarea value={issue.proposedSolution} onChange={(e) => setIssue({ ...issue, proposedSolution: e.target.value })} /></Field><Field label="Solución aplicada"><textarea value={issue.appliedSolution} onChange={(e) => setIssue({ ...issue, appliedSolution: e.target.value })} /></Field><SubmitBar><button className="primary">Guardar incidencia</button><button type="button" onClick={resetDrawer}>Cancelar</button></SubmitBar></form>}{drawer === 'requirement' && <form className="form-grid drawer-form" onSubmit={saveReq}><Field label="Requisito"><textarea required value={req.text} onChange={(e) => setReq({ ...req, text: e.target.value })} /></Field><Field label="Tipo"><select value={req.type} onChange={(e) => setReq({ ...req, type: Number(e.target.value) })}>{enumOptions(requirementTypes)}</select></Field><Field label="Comunicado a"><select value={req.communicatedToContactId} onChange={(e) => setReq({ ...req, communicatedToContactId: e.target.value })}><option value="">Sin contacto</option>{(contacts.data || []).map((c) => <option key={c.id} value={c.id}>{c.displayName || c.name}</option>)}</select></Field><Field label="Cumplimiento"><select value={req.complianceStatus} onChange={(e) => setReq({ ...req, complianceStatus: Number(e.target.value) })}>{enumOptions(complianceStatuses)}</select></Field><Field label="Justificación"><textarea value={req.justification} onChange={(e) => setReq({ ...req, justification: e.target.value })} /></Field><SubmitBar><button className="primary">Guardar requisito</button><button type="button" onClick={resetDrawer}>Cancelar</button></SubmitBar></form>}{drawer === 'decision' && <form className="form-grid drawer-form" onSubmit={saveDecision}><Field label="Título"><input required value={decision.title} onChange={(e) => setDecision({ ...decision, title: e.target.value })} /></Field><Field label="Impacto económico"><input type="number" step="0.01" value={decision.economicImpact} onChange={(e) => setDecision({ ...decision, economicImpact: e.target.value })} /></Field><Field label="Decisión tomada"><textarea required value={decision.decisionText} onChange={(e) => setDecision({ ...decision, decisionText: e.target.value })} /></Field><Field label="Motivo"><textarea value={decision.reason} onChange={(e) => setDecision({ ...decision, reason: e.target.value })} /></Field><Field label="Alternativas"><textarea value={decision.alternatives} onChange={(e) => setDecision({ ...decision, alternatives: e.target.value })} /></Field><SubmitBar><button className="primary">Guardar decisión</button><button type="button" onClick={resetDrawer}>Cancelar</button></SubmitBar></form>}</Drawer></div>;
}

function ActivityPage({ projectId }: { projectId: number }) {
  const [filters, setFilters] = useState({ entityType: '', q: '' });
  const { data } = useApi<Activity[]>(`/api/timeline?projectId=${projectId}`, [projectId]);
  const filtered = (data || []).filter((x) => (!filters.entityType || x.entityType === filters.entityType) && matchesSearch(filters.q, x.action, x.summary, x.entityType));
  return <div className="page-grid"><PageHeader title="Actividad global" summary="Historial consultable del proyecto. Las altas viven ahora en Seguimiento y en las fichas." /><Panel title="Cronología"><div className="filter-bar"><input placeholder="Buscar en actividad..." value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value })} /><select value={filters.entityType} onChange={(e) => setFilters({ ...filters, entityType: e.target.value })}><option value="">Todas las entidades</option>{entityTypes.map((x) => <option key={x} value={x}>{x}</option>)}</select></div><Timeline items={filtered} /></Panel></div>;
}

function ContextNotebookPanel({ projectId, entityType, entityId, entityName, onOpenEntity }: { projectId: number; entityType: string; entityId: number; entityName: string; onOpenEntity: (type: string, id: number) => void }) {
  const context = useApi<EntityContext>(`/api/entity-context?projectId=${projectId}&entityType=${encodeURIComponent(entityType)}&entityId=${entityId}`, [projectId, entityType, entityId]);
  const notes = useApi<Note[]>(`/api/notes?projectId=${projectId}&entityType=${encodeURIComponent(entityType)}&entityId=${entityId}`, [projectId, entityType, entityId]);
  const timeline = useApi<Activity[]>(`/api/timeline?projectId=${projectId}&entityType=${encodeURIComponent(entityType)}&entityId=${entityId}`, [projectId, entityType, entityId]);
  const [draft, setDraft] = useState({ body: '', occurredAt: localDateTimeValue(), pinned: false });
  const [error, setError] = useState('');
  const saveNote = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!draft.body.trim()) return;
    setError('');
    try {
      await api.post('/api/notes', {
        projectId,
        body: draft.body.trim(),
        occurredAt: toUtc(draft.occurredAt),
        primaryWorkItemId: entityType === 'WorkItem' ? entityId : null,
        primaryContactId: entityType === 'Contact' ? entityId : null,
        isPinned: draft.pinned,
        references: [{ targetEntityType: entityType, targetEntityId: entityId }]
      });
      setDraft({ body: '', occurredAt: localDateTimeValue(), pinned: false });
      await notes.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo guardar la nota');
    }
  };
  const promote = async (note: Note, targetType: string) => {
    await api.post(`/api/notes/${note.id}/promote`, { targetType, title: undefined });
    await notes.reload();
    await context.reload();
  };
  const removeNote = async (note: Note) => {
    if (!window.confirm('Eliminar esta nota de forma controlada?')) return;
    await api.delete(`/api/notes/${note.id}`);
    await notes.reload();
  };
  const structured = context.data?.structured || [];
  const legacy = context.data?.legacy || [];
  const noteItems = notes.data || [];
  return <div className="context-notebook"><Panel title="Contexto">{structured.length ? <div className="context-list">{structured.map((item) => <button key={`${item.role}:${item.entityType}:${item.entityId}`} onClick={() => onOpenEntity(item.entityType, item.entityId)}><span>{item.role}</span><b>{item.label}</b>{item.detail && <small>{item.detail}</small>}</button>)}</div> : <p className="note">Sin contexto estructurado todavía. Puedes capturar una nota ahora y estructurarla después.</p>}{legacy.length > 0 && <details className="legacy-links"><summary>Vínculos pendientes de revisión ({legacy.length})</summary><div className="context-list">{legacy.map((item) => <button key={`pending:${item.role}:${item.entityType}:${item.entityId}`} onClick={() => onOpenEntity(item.entityType, item.entityId)}><span>{item.role}</span><b>{item.label}</b>{item.detail && <small>{item.detail}</small>}</button>)}</div></details>}</Panel><Panel title="Bitácora"><form className="note-composer" onSubmit={saveNote}><textarea value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} placeholder={`Añadir nota sobre ${entityName}`} /><div className="note-tools"><input type="datetime-local" value={draft.occurredAt} onChange={(e) => setDraft({ ...draft, occurredAt: e.target.value })} /><label className="check-row"><input type="checkbox" checked={draft.pinned} onChange={(e) => setDraft({ ...draft, pinned: e.target.checked })} />Fijar</label><button className="primary">Añadir nota</button></div>{error && <span className="form-error">{error}</span>}</form>{noteItems.length ? <div className="notes-list">{noteItems.map((note) => <article key={note.id} className={note.isPinned ? 'pinned' : ''}><header><time>{dateTime.format(new Date(note.occurredAt))}</time>{note.isPinned && <StatusBadge>Fijada</StatusBadge>}</header><p>{displayNoteBody(note.body)}</p><div className="inline-actions"><button onClick={() => promote(note, 'Task')}>Convertir en tarea</button><button onClick={() => promote(note, 'Issue')}>Incidencia</button><button onClick={() => promote(note, 'Appointment')}>Cita</button><button onClick={() => promote(note, 'Requirement')}>Requisito</button><button onClick={() => promote(note, 'Decision')}>Decisión</button><button onClick={() => promote(note, 'BudgetRequest')}>Solicitud</button><button className="danger ghost-danger" onClick={() => removeNote(note)}>Eliminar</button></div></article>)}</div> : <p className="note">Sin notas para esta ficha.</p>}{timeline.data?.length ? <details className="activity-compact"><summary>Actividad automática ({timeline.data.length})</summary><Timeline items={timeline.data} /></details> : null}</Panel><details className="advanced-relations"><summary>Más · Relacionar con otro elemento</summary><EntityRelationsPanel projectId={projectId} entityType={entityType} entityId={entityId} entityName={entityName} onOpenEntity={onOpenEntity} /></details></div>;
}

function RelationMigrationPage({ projectId }: { projectId: number }) {
  const preview = useApi<RelationMigrationItem[]>(`/api/relation-migration/preview?projectId=${projectId}`, [projectId]);
  const run = async () => {
    if (!window.confirm('Ejecutar migración aditiva idempotente de relaciones antiguas? No elimina vínculos existentes.')) return;
    await api.post(`/api/relation-migration/run?projectId=${projectId}`, {});
    await preview.reload();
  };
  return <div className="page-grid"><PageHeader title="Migración de relaciones" summary="Vista administrativa temporal para pasar del grafo genérico a contexto, notas y campos de dominio." action={<PrimaryAction onClick={run}>Ejecutar migración segura</PrimaryAction>} /><Panel title="Dry-run y revisión manual">{preview.data?.length ? <DataTable headers={['Relación', 'Origen', 'Destino', 'Tipo antiguo', 'Propuesta', 'Estado']} rows={preview.data.map((item) => [String(item.entityLinkId), item.source, item.target, item.oldType, item.proposal, <StatusBadge>{item.status}</StatusBadge>])} /> : <EmptyState title={preview.loading ? 'Calculando dry-run...' : 'No hay relaciones antiguas pendientes.'} />}</Panel></div>;
}

function EntityRelationsPanel({ projectId, entityType, entityId, entityName, onOpenEntity }: { projectId: number; entityType: string; entityId: number; entityName: string; onOpenEntity: (type: string, id: number) => void }) {
  const links = useApi<EntityLink[]>(`/api/entity-links?projectId=${projectId}&entityType=${encodeURIComponent(entityType)}&entityId=${entityId}`, [projectId, entityType, entityId]);
  const workItems = useApi<WorkItem[]>(`/api/work-items?projectId=${projectId}`, [projectId]);
  const contacts = useApi<Contact[]>(`/api/contacts?projectId=${projectId}`, [projectId]);
  const tasks = useApi<Task[]>(`/api/tasks?projectId=${projectId}`, [projectId]);
  const requests = useApi<BudgetRequest[]>(`/api/budget-requests?projectId=${projectId}`, [projectId]);
  const quotes = useApi<Quote[]>(`/api/quotes?projectId=${projectId}`, [projectId]);
  const invoices = useApi<InvoiceRow[]>(`/api/invoices?projectId=${projectId}`, [projectId]);
  const documents = useApi<DocumentRow[]>(`/api/documents?projectId=${projectId}`, [projectId]);
  const issues = useApi<Issue[]>(`/api/issues?projectId=${projectId}`, [projectId]);
  const requirements = useApi<Requirement[]>(`/api/requirements?projectId=${projectId}`, [projectId]);
  const decisions = useApi<Decision[]>(`/api/decisions?projectId=${projectId}`, [projectId]);
  const [draft, setDraft] = useState(() => {
    const firstRule = rulesForEntity(entityType)[0];
    return { targetType: firstRule.targetType, target: '', type: advancedLinkType(firstRule.linkType), description: '' };
  });
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const lookup = useMemo(() => {
    const map: Record<string, string> = { [`Project:${projectId}`]: 'Proyecto activo', [`${entityType}:${entityId}`]: entityName };
    (workItems.data || []).forEach((x) => { map[`WorkItem:${x.id}`] = x.title; });
    (contacts.data || []).forEach((x) => { map[`Contact:${x.id}`] = x.displayName || x.name; });
    (tasks.data || []).forEach((x) => { map[`Task:${x.id}`] = x.title; });
    (requests.data || []).forEach((x) => { map[`BudgetRequest:${x.id}`] = x.title; });
    (quotes.data || []).forEach((x) => { map[`Quote:${x.id}`] = x.reference; });
    (invoices.data || []).forEach((x) => { map[`Invoice:${x.invoice.id}`] = x.invoice.number; });
    (documents.data || []).forEach((x) => { map[`Document:${x.id}`] = x.title; });
    (issues.data || []).forEach((x) => { map[`Issue:${x.id}`] = x.title; });
    (requirements.data || []).forEach((x) => { map[`Requirement:${x.id}`] = x.text; });
    (decisions.data || []).forEach((x) => { map[`Decision:${x.id}`] = x.title; });
    return map;
  }, [projectId, entityType, entityId, entityName, workItems.data, contacts.data, tasks.data, requests.data, quotes.data, invoices.data, documents.data, issues.data, requirements.data, decisions.data]);
  const entityOptions = useMemo(() => Object.entries(lookup)
    .filter(([key]) => key !== `${entityType}:${entityId}`)
    .map(([key, label]) => {
      const [type, id] = key.split(':');
      return { key, type, id: Number(id), label };
    })
    .sort((a, b) => `${entityTypeLabels[a.type] || a.type} ${a.label}`.localeCompare(`${entityTypeLabels[b.type] || b.type} ${b.label}`)), [lookup, entityType, entityId]);
  const activeRules = rulesForEntity(entityType).filter((rule) => entityOptions.some((option) => option.type === rule.targetType));
  const fallbackTypes = entityOptions.filter((option) => !activeRules.some((rule) => rule.targetType === option.type)).map((option) => option.type);
  const availableRules = [
    ...activeRules,
    ...Array.from(new Set(fallbackTypes)).map((targetType) => ({ targetType, linkType: 4, reason: 'vinculo auxiliar disponible; usalo solo si la relacion tiene sentido operativo.' }))
  ];
  const selectedRule = availableRules.find((rule) => rule.targetType === draft.targetType) || availableRules[0];
  const filteredOptions = entityOptions.filter((option) =>
    (!draft.targetType || option.type === draft.targetType) &&
    matchesSearch(query, option.label, entityTypeLabels[option.type] || option.type)
  );
  const currentLinks = links.data || [];
  const groupedLinks = currentLinks.reduce<Record<string, EntityLink[]>>((acc, link) => {
    const other = otherSide(link, entityType, entityId);
    const type = other.type;
    acc[type] = [...(acc[type] || []), link];
    return acc;
  }, {});
  const hasLinkTo = (type: string, id: number) => currentLinks.some((link) => relationTouches(link, type, id));
  const recommendedTypes = availableRules.map((rule) => rule.targetType);
  const suggestions = recommendedTypes.flatMap((type) => entityOptions.filter((option) => option.type === type && !hasLinkTo(option.type, option.id)).slice(0, 3)).slice(0, 8);
  const setTarget = (key: string) => {
    const option = entityOptions.find((x) => x.key === key);
    setDraft({ ...draft, target: key, targetType: option?.type || draft.targetType });
  };
  const selectTargetType = (targetType: string) => {
    const rule = availableRules.find((x) => x.targetType === targetType);
    setDraft({ ...draft, targetType, target: '', type: advancedLinkType(rule?.linkType ?? draft.type) });
    setQuery('');
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    const [targetType, targetId] = draft.target.split(':');
    try {
      await api.post('/api/entity-links', { projectId, sourceType: entityType, sourceId: entityId, targetType, targetId: Number(targetId), type: Number(draft.type), description: draft.description });
      setDraft({ ...draft, target: '', description: '' });
      setQuery('');
      await links.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo crear la relación');
    }
  };
  const remove = async (link: EntityLink) => {
    if (!window.confirm('Quitar esta relación contextual?')) return;
    await api.delete(`/api/entity-links/${link.id}`);
    await links.reload();
  };
  const linkedEntity = (type: string, id: number) => <button className="link-button" onClick={() => onOpenEntity(type, id)}>{entityLabel(type, id, lookup)}</button>;
  const targetHint = relationTypeHints[draft.targetType];
  return <div className="relations-panel"><div className="relations-heading"><div><h3>Relaciones contextuales</h3><p className="note">Conecta {entityTypeLabels[entityType] || entityType} con otros elementos sólo cuando explique trabajo, bloqueo, coste, documento o trazabilidad.</p></div><Link2 size={18} /></div>{currentLinks.length ? <div className="relations-groups">{Object.entries(groupedLinks).map(([type, group]) => <section key={type}><h4>{entityTypeLabels[type] || type}</h4>{group.map((link) => {
    const other = otherSide(link, entityType, entityId);
    return <article key={link.id} className="relation-card"><div><span>{enumLabel(linkTypes, link.type)}</span>{linkedEntity(other.type, other.id)}{link.description && <p>{link.description}</p>}</div><button className="danger ghost-danger" onClick={() => remove(link)}>Quitar</button></article>;
  })}</section>)}</div> : <EmptyState title="Aún no hay relaciones explícitas para esta ficha." />}<form className="relation-composer" onSubmit={save}><div className="relation-intent"><span>Vas a relacionar</span><b>{entityTypeLabels[entityType] || entityType}</b><span>con...</span></div><div className="relation-type-pills">{availableRules.map((rule) => {
    const hint = relationTypeHints[rule.targetType];
    return <button key={rule.targetType} type="button" className={draft.targetType === rule.targetType ? 'active' : ''} onClick={() => selectTargetType(rule.targetType)}><b>{entityTypeLabels[rule.targetType] || rule.targetType}</b><small>{rule.reason}</small>{hint && <em>{hint.definition}</em>}</button>;
  })}</div>{targetHint && <div className="relation-help"><b>{entityTypeLabels[draft.targetType] || draft.targetType}</b><p>{targetHint.definition}</p><p><strong>Úsalo cuando:</strong> {targetHint.useWhen}</p><p><strong>Ejemplo:</strong> {targetHint.example}</p>{selectedRule && <p><strong>Vínculo sugerido:</strong> {enumLabel(linkTypes, selectedRule.linkType)} · {selectedRule.reason}</p>}</div>}<div className="form-grid relation-form"><Field label="Buscar dentro de esa categoría"><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filtra por nombre, referencia o título" /></Field><Field label={`Seleccionar ${entityTypeLabels[draft.targetType] || 'entidad'}`}><select required value={draft.target} onChange={(e) => setTarget(e.target.value)}><option value="">Seleccionar {entityTypeLabels[draft.targetType] || 'entidad'}</option>{filteredOptions.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</select></Field><Field label="Tipo de vínculo"><select value={draft.type} onChange={(e) => setDraft({ ...draft, type: Number(e.target.value) })}>{advancedLinkTypeOptions.map((id) => <option key={id} value={id}>{linkTypes[id]}</option>)}</select></Field><Field label="Contexto"><input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder={selectedRule ? selectedRule.reason : 'Explica por qué existe esta relación'} /></Field><SubmitBar error={error}><button className="primary"><Link2 size={17} />Añadir relación</button></SubmitBar></div>{suggestions.length > 0 && <div className="relation-suggestions"><span>Sugerencias</span>{suggestions.map((option) => <button key={option.key} type="button" onClick={() => setTarget(option.key)}>{entityTypeLabels[option.type] || option.type}: {option.label}</button>)}</div>}</form></div>;
}
createRoot(document.getElementById('root')!).render(<ErrorBoundary><App /></ErrorBoundary>);
