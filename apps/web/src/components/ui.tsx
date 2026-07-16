/** Shared presentation primitives for the workbench interface. */
import type { ReactNode, FormEventHandler, ChangeEventHandler } from "react";
import {
  Alert,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Chip,
  Input,
  Separator,
  Spinner,
  TextArea
} from "@heroui/react";

export function Panel({
  eyebrow,
  title,
  description,
  actions,
  children,
  footer,
  className = ""
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <Card className={`workbench-panel w-full shadow-none ${className}`.trim()}>
      <CardHeader className="workbench-panel-header flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          {eyebrow ? <p className="section-eyebrow">{eyebrow}</p> : null}
          <CardTitle className="workbench-panel-title">{title}</CardTitle>
          {description ? <CardDescription className="workbench-panel-description max-w-3xl">{description}</CardDescription> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </CardHeader>
      {children ? <CardContent className="workbench-panel-content space-y-4">{children}</CardContent> : null}
      {footer ? <CardFooter className="workbench-panel-footer flex flex-wrap gap-2">{footer}</CardFooter> : null}
    </Card>
  );
}

export function Notice({
  children,
  tone = "success"
}: {
  children: ReactNode;
  tone?: "success" | "danger" | "warning" | "default";
}) {
  if (!children) return null;
  const status = tone === "danger" ? "danger" : tone === "warning" ? "warning" : tone === "success" ? "success" : undefined;
  return (
    <Alert status={status} className={`workbench-notice ${tone} text-sm`}>
      {children}
    </Alert>
  );
}

export function Field({
  label,
  children,
  className = ""
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={`workbench-field grid gap-1.5 text-sm text-foreground ${className}`.trim()}>
      <span>{label}</span>
      {children}
    </label>
  );
}

export function TextInput(props: {
  value: string;
  onChange: ChangeEventHandler<HTMLInputElement>;
  placeholder?: string;
  required?: boolean;
  type?: string;
  disabled?: boolean;
  "aria-label"?: string;
}) {
  return <Input {...props} className="workbench-input w-full" />;
}

export function TextAreaField(props: {
  value: string;
  onChange: ChangeEventHandler<HTMLTextAreaElement>;
  placeholder?: string;
  rows?: number;
  required?: boolean;
  disabled?: boolean;
  "aria-label"?: string;
}) {
  return <TextArea {...props} className="workbench-input w-full min-h-24" />;
}

export function SelectField(props: {
  value: string;
  onChange: ChangeEventHandler<HTMLSelectElement>;
  children: ReactNode;
  disabled?: boolean;
  "aria-label"?: string;
  className?: string;
}) {
  return (
    <select
      {...props}
      className={`workbench-select w-full ${props.className ?? ""}`.trim()}
    />
  );
}

export function PrimaryButton(props: {
  children: ReactNode;
  onPress?: () => void;
  type?: "button" | "submit";
  isDisabled?: boolean;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const { type = "button", ...rest } = props;
  if (type === "submit") {
    return (
      <Button
        type="submit"
        variant="primary"
        size={rest.size ?? "md"}
        isDisabled={rest.isDisabled}
        className={`workbench-button workbench-button-primary ${rest.className ?? ""}`.trim()}
      >
        {rest.children}
      </Button>
    );
  }
  return (
    <Button
      variant="primary"
      size={rest.size ?? "md"}
      isDisabled={rest.isDisabled}
      className={`workbench-button workbench-button-primary ${rest.className ?? ""}`.trim()}
      onPress={rest.onPress}
    >
      {rest.children}
    </Button>
  );
}

export function QuietButton(props: {
  children: ReactNode;
  onPress?: () => void;
  isDisabled?: boolean;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  return (
    <Button
      variant="secondary"
      size={props.size ?? "sm"}
      isDisabled={props.isDisabled}
      className={`workbench-button workbench-button-secondary ${props.className ?? ""}`.trim()}
      onPress={props.onPress}
    >
      {props.children}
    </Button>
  );
}

export function DangerButton(props: {
  children: ReactNode;
  onPress?: () => void;
  isDisabled?: boolean;
  size?: "sm" | "md" | "lg";
}) {
  return (
    <Button
      variant="danger"
      size={props.size ?? "sm"}
      isDisabled={props.isDisabled}
      className="workbench-button workbench-button-danger"
      onPress={props.onPress}
    >
      {props.children}
    </Button>
  );
}

export function Tag({
  children,
  color = "default"
}: {
  children: ReactNode;
  color?: "default" | "accent" | "success" | "warning" | "danger";
}) {
  return (
    <Chip size="sm" variant="soft" color={color} className={`workbench-tag tag-${color}`}>
      {children}
    </Chip>
  );
}

export function RowActions({ children }: { children: ReactNode }) {
  return <div className="row-actions flex flex-wrap gap-2">{children}</div>;
}

export function Stack({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`stack-list grid gap-3 ${className}`.trim()}>{children}</div>;
}

export function Grid2({ children }: { children: ReactNode }) {
  return <div className="grid gap-3 sm:grid-cols-2">{children}</div>;
}

export function ListCard({
  children,
  actions,
  className = ""
}: {
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`workbench-list-card flex flex-wrap items-start justify-between gap-3 ${className}`.trim()}>
      <div className="min-w-0 flex-1 space-y-1">{children}</div>
      {actions ? <RowActions>{actions}</RowActions> : null}
    </div>
  );
}

export function EmptyHint({ children }: { children: ReactNode }) {
  return <p className="empty-hint text-sm text-muted">{children}</p>;
}

export function LoadingLabel({ label = "加载中…" }: { label?: string }) {
  return (
    <span className="loading-label inline-flex items-center gap-2 text-sm text-muted">
      <Spinner size="sm" />
      {label}
    </span>
  );
}

export function FormBlock({
  onSubmit,
  children
}: {
  onSubmit: FormEventHandler<HTMLFormElement>;
  children: ReactNode;
}) {
  return (
    <form className="workbench-form grid gap-3" onSubmit={onSubmit}>
      {children}
    </form>
  );
}

export function Divider() {
  return <Separator className="workbench-divider my-1" />;
}

export { Button, Card, CardContent, CardHeader, CardTitle, CardDescription, Chip, Input, TextArea, Alert, Spinner };
