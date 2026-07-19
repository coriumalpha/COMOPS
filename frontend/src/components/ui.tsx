import React from "react";
import { AlertTriangle, Loader2, Plus, X } from "lucide-react";
import { dateTime } from "../api/client";
import type { Activity, Alert, Appointment } from "../domain";

export function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function SubmitBar({
  error,
  children,
}: {
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="submit-bar">
      {children}
      {error && <span className="form-error">{error}</span>}
    </div>
  );
}

export function PageHeader({
  title,
  summary,
  action,
}: {
  title: string;
  summary?: string;
  action?: React.ReactNode;
}) {
  return (
    <section className="page-header">
      <div>
        <h2>{title}</h2>
        {summary && <p>{summary}</p>}
      </div>
      {action && <div className="page-actions">{action}</div>}
    </section>
  );
}

export function PrimaryAction({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button className="primary" onClick={onClick}>
      <Plus size={17} />
      {children}
    </button>
  );
}

export function EmptyState({
  title,
  action,
}: {
  title: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty-state" role="status">
      <p>{title}</p>
      {action}
    </div>
  );
}

export function InlineNotice({
  tone = "info",
  children,
}: {
  tone?: "info" | "error" | "warning";
  children: React.ReactNode;
}) {
  return (
    <div
      className={`inline-notice ${tone}`}
      role={tone === "error" ? "alert" : "status"}
    >
      {tone === "info" ? <Loader2 size={15} /> : <AlertTriangle size={15} />}
      <span>{children}</span>
    </div>
  );
}

export function ApiState({
  loading,
  error,
}: {
  loading?: boolean;
  error?: string;
}) {
  if (error) return <InlineNotice tone="error">{error}</InlineNotice>;
  if (loading) return <InlineNotice>Cargando datos...</InlineNotice>;
  return null;
}

export function Drawer({
  title,
  open,
  onClose,
  children,
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="drawer-backdrop">
      <aside
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          <h2>{title}</h2>
          <button onClick={onClose} aria-label="Cerrar">
            <X size={17} />
          </button>
        </header>
        {children}
      </aside>
    </div>
  );
}

export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: Array<{ id: T; label: string }>;
  active: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          role="tab"
          aria-selected={active === tab.id}
          className={active === tab.id ? "active" : ""}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function StatusSummary({ items }: { items: Array<[string, number]> }) {
  return (
    <div className="summary-strip">
      {items.map(([label, value]) => (
        <span key={label}>
          <b>{value}</b>
          {label}
        </span>
      ))}
    </div>
  );
}

export function Panel({
  title,
  children,
}: {
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="panel">
      {title && (
        <header className="panel-heading">
          <h2>{title}</h2>
        </header>
      )}
      {children}
    </section>
  );
}

export function KpiGrid({ items }: { items: Array<[string, string]> }) {
  return (
    <section className="kpi-grid">
      {items.map(([label, value]) => (
        <article key={label}>
          <span>{label}</span>
          <b>{value}</b>
        </article>
      ))}
    </section>
  );
}

export function CardGrid({ children }: { children: React.ReactNode }) {
  return <div className="card-grid">{children}</div>;
}

export function StatusBadge({ children }: { children: React.ReactNode }) {
  return <span className="status-badge">{children}</span>;
}

export function Detail({
  title,
  description,
  rows,
}: {
  title: string;
  description?: string;
  rows: Array<[string, string]>;
}) {
  return (
    <article className="detail">
      <h2>{title}</h2>
      {description && <p>{description}</p>}
      <dl>
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </article>
  );
}

export function DataTable({
  headers,
  rows,
}: {
  headers: string[];
  rows: Array<Array<React.ReactNode>>;
}) {
  if (!rows.length) return <EmptyState title="Sin registros para mostrar." />;
  return (
    <div className="table-wrap" role="region" aria-label="Tabla de datos">
      <table>
        <thead>
          <tr>
            {headers.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j} data-label={headers[j]}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Timeline({ items }: { items: Activity[] }) {
  return (
    <ol className="timeline">
      {items.map((item) => (
        <li key={item.id}>
          <time>{dateTime.format(new Date(item.occurredAtUtc))}</time>
          <b>{item.action}</b>
          <span>{item.summary}</span>
          <small>
            {item.entityType} #{item.entityId}
          </small>
        </li>
      ))}
    </ol>
  );
}

export function AlertList({
  alerts,
  onOpenEntity,
}: {
  alerts: Alert[];
  onOpenEntity?: (type: string, id: number) => void;
}) {
  if (!alerts.length) return <p className="note">Sin alertas activas.</p>;
  return (
    <div className="alert-list">
      {alerts.map((a) => (
        <article key={a.id}>
          <AlertTriangle size={17} />
          <div>
            <b>{a.title}</b>
            <span>
              {a.dueUtc
                ? dateTime.format(new Date(a.dueUtc))
                : `${a.entityType} #${a.entityId}`}
            </span>
            {onOpenEntity && (
              <button
                className="link-button"
                onClick={() => onOpenEntity(a.entityType, a.entityId)}
              >
                Abrir objeto
              </button>
            )}
          </div>
        </article>
      ))}
    </div>
  );
}

export function Agenda({ items }: { items: Appointment[] }) {
  if (!items.length) return <p className="note">Sin citas próximas.</p>;
  return (
    <div className="agenda">
      {items.map((a) => (
        <article key={a.id}>
          <b>{a.title}</b>
          <span>{dateTime.format(new Date(a.startUtc))}</span>
          <small>{a.location || a.participants || "-"}</small>
        </article>
      ))}
    </div>
  );
}

export function MiniList({ items }: { items: string[] }) {
  if (!items.length) return <p className="note">Sin registros.</p>;
  return (
    <ul className="mini-list">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: string }
> {
  state = { error: "" };

  static getDerivedStateFromError(error: unknown) {
    return {
      error:
        error instanceof Error
          ? error.message
          : "Error inesperado en la interfaz.",
    };
  }

  render() {
    if (this.state.error) {
      return (
        <main className="page-grid">
          <InlineNotice tone="error">{this.state.error}</InlineNotice>
          <button onClick={() => window.location.reload()}>
            Recargar aplicación
          </button>
        </main>
      );
    }
    return this.props.children;
  }
}
