import { useEffect, useState } from "react";
import {
  healthToStatus,
  serviceFailureStatus,
  serviceStatusCopy,
  type HealthResponse,
  type ServiceStatus
} from "./lib/serviceStatus.js";
import { ProjectsPanel } from "./components/ProjectsPanel.js";
import { TodoBoard } from "./components/TodoBoard.js";
import { ConnectionsPanel } from "./components/ConnectionsPanel.js";
import { McpPanel } from "./components/McpPanel.js";
import { RolesPanel } from "./components/RolesPanel.js";
import { QueueGuardPanel } from "./components/QueueGuardPanel.js";
import { BackupPanel } from "./components/BackupPanel.js";
import { PwaInstallGuidePanel } from "./components/PwaInstallGuidePanel.js";
import { resolveRuntimeServiceUrl } from "./lib/serviceUrl.js";
import "./styles.css";

/** Same-origin on installed loopback PWA (any -Port); VITE_SERVICE_URL for Vite dev. */
const serviceUrl = resolveRuntimeServiceUrl({
  viteServiceUrl: import.meta.env.VITE_SERVICE_URL as string | undefined,
  location:
    typeof window !== "undefined"
      ? {
          hostname: window.location.hostname,
          origin: window.location.origin,
          port: window.location.port,
          protocol: window.location.protocol
        }
      : undefined
});

export function App() {
  const [status, setStatus] = useState<ServiceStatus>({ kind: "offline" });
  /** Bumped after a successful backup import so sibling panels re-fetch without a full page reload. */
  const [dataEpoch, setDataEpoch] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`${serviceUrl}/api/health`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`服务返回 ${response.status}`);
        return (await response.json()) as HealthResponse;
      })
      .then((health) => setStatus(healthToStatus(health)))
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setStatus(serviceFailureStatus(error));
      });
    return () => controller.abort();
  }, []);

  const copy = serviceStatusCopy(status);
  const online = status.kind === "online";
  return (
    <main className="shell">
      <section className="hero" aria-labelledby="title">
        <p className="eyebrow">LOCAL-FIRST AGENT WORKBENCH</p>
        <h1 id="title">Personal AI Workbench</h1>
        <p>规划确认 → 专业执行 → 独立审查 → 用户验收</p>
      </section>
      <section className={`service-card ${status.kind}`} aria-live="polite">
        <span className="status-dot" aria-hidden="true" />
        <div>
          <h2>{copy.label}</h2>
          <p>{copy.detail}</p>
        </div>
      </section>
      <ProjectsPanel serviceUrl={serviceUrl} available={online} dataEpoch={dataEpoch} />
      <ConnectionsPanel serviceUrl={serviceUrl} available={online} dataEpoch={dataEpoch} />
      <McpPanel serviceUrl={serviceUrl} available={online} dataEpoch={dataEpoch} />
      <RolesPanel serviceUrl={serviceUrl} available={online} dataEpoch={dataEpoch} />
      <QueueGuardPanel serviceUrl={serviceUrl} available={online} dataEpoch={dataEpoch} />
      <TodoBoard serviceUrl={serviceUrl} available={online} dataEpoch={dataEpoch} />
      <BackupPanel
        serviceUrl={serviceUrl}
        available={online}
        onImportSuccess={() => setDataEpoch((epoch) => epoch + 1)}
      />
      <PwaInstallGuidePanel serviceUrl={serviceUrl} />
    </main>
  );
}
