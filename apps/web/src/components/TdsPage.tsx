import type { ReactNode } from "react";

/**
 * todos.dev page chrome: kicker + title + description + optional primary action.
 */
export function TdsPage({
  kicker,
  title,
  description,
  action,
  children,
  className = ""
}: {
  kicker?: string;
  title: string;
  description?: string;
  action?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`tds-page ${className}`.trim()}>
      <header className="tds-page-header">
        <div className="tds-page-header-copy">
          {kicker ? <p className="tds-kicker">{kicker}</p> : null}
          <h1 className="tds-page-title">{title}</h1>
          {description ? <p className="tds-page-desc">{description}</p> : null}
        </div>
        {action ? <div className="tds-page-header-action">{action}</div> : null}
      </header>
      <div className="tds-page-body">{children}</div>
    </div>
  );
}

export function TdsEmpty({
  icon,
  title,
  description,
  action
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="tds-empty-card">
      {icon ? <div className="tds-empty-icon">{icon}</div> : null}
      <p className="tds-empty-title">{title}</p>
      {description ? <p className="tds-empty-desc">{description}</p> : null}
      {action}
    </div>
  );
}

export function TdsBanner({
  children,
  tone = "default"
}: {
  children: ReactNode;
  tone?: "ok" | "warn" | "err" | "default";
}) {
  if (!children) return null;
  return <div className={`tds-banner ${tone === "default" ? "" : tone}`.trim()}>{children}</div>;
}

export function TdsPrimaryButton(props: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={props.type ?? "button"}
      className="tds-btn-primary"
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

export function TdsGhostButton(props: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      className={`tds-btn-ghost${props.danger ? " danger" : ""}`}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

export function LinkIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <circle cx="8" cy="8" r="3" />
      <circle cx="16" cy="16" r="3" />
      <path d="M10.5 10.5 13.5 13.5" />
    </svg>
  );
}

export function InboxIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M4 6h16v12H4z" />
      <path d="M4 12h4l2 3h4l2-3h4" />
    </svg>
  );
}

export function ListIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M8 7h12M8 12h12M8 17h12" />
      <path d="M4 7h.01M4 12h.01M4 17h.01" />
    </svg>
  );
}

export function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M3 7.5h7l2 2h9v9.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7.5Z" />
    </svg>
  );
}
