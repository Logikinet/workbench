import { useCallback, useEffect, useState } from "react";
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
import { RoleRouterPanel } from "./components/RoleRouterPanel.js";
import { QueueGuardPanel } from "./components/QueueGuardPanel.js";
import { BackupPanel } from "./components/BackupPanel.js";
import { PwaInstallGuidePanel } from "./components/PwaInstallGuidePanel.js";
import { SessionPanel } from "./components/SessionPanel.js";
import { WorkbenchNav } from "./components/WorkbenchNav.js";
import { HomeDashboard } from "./components/HomeDashboard.js";
import { WaitingOnMeCenter } from "./components/WaitingOnMeCenter.js";
import { DocumentWorkflowPanel } from "./components/DocumentWorkflowPanel.js";
import {
  formatWorkbenchHash,
  parseWorkbenchHash,
  type WorkbenchRoute
} from "./lib/workbenchRoutes.js";
import {
  loadWorkbenchDashboard,
  type WorkbenchDashboardSnapshot
} from "./lib/workbenchDashboard.js";
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

const emptyCounts = {
  pending: 0,
  running: 0,
  waitingOnUser: 0,
  reviewFailed: 0,
  awaitingAcceptance: 0,
  completed: 0
};

function readRoute(): WorkbenchRoute {
  if (typeof window === "undefined") return { section: "home" };
  return parseWorkbenchHash(window.location.hash || "#/home");
}

export function App() {
  const [status, setStatus] = useState<ServiceStatus>({ kind: "offline" });
  /** Bumped after a successful backup import so sibling panels re-fetch without a full page reload. */
  const [dataEpoch, setDataEpoch] = useState(0);
  const [route, setRoute] = useState<WorkbenchRoute>(readRoute);
  const [dashboard, setDashboard] = useState<WorkbenchDashboardSnapshot | null>(null);
  const [dashboardLoading, setDashboardLoading] = useState(false);
  const [dashboardError, setDashboardError] = useState("");

  const navigate = useCallback((next: WorkbenchRoute) => {
    const hash = formatWorkbenchHash(next);
    if (typeof window !== "undefined" && window.location.hash !== hash) {
      window.location.hash = hash;
    }
    setRoute(next);
  }, []);

  useEffect(() => {
    const onHash = () => setRoute(readRoute());
    window.addEventListener("hashchange", onHash);
    if (!window.location.hash) {
      window.location.hash = "#/home";
    }
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

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

  const refreshDashboard = useCallback(async () => {
    if (status.kind !== "online") return;
    setDashboardLoading(true);
    try {
      const snapshot = await loadWorkbenchDashboard(serviceUrl);
      setDashboard(snapshot);
      setDashboardError("");
    } catch (error) {
      setDashboardError(error instanceof Error ? error.message : "无法加载工作台概览");
    } finally {
      setDashboardLoading(false);
    }
  }, [status.kind]);

  useEffect(() => {
    void refreshDashboard();
  }, [refreshDashboard, dataEpoch]);

  const copy = serviceStatusCopy(status);
  const online = status.kind === "online";
  const counts = dashboard?.counts ?? emptyCounts;
  const waitingItems = dashboard?.waitingItems ?? [];

  return (
    <div className="workbench-app">
      <a className="skip-link" href="#workbench-main">
        跳到主内容
      </a>
      <WorkbenchNav route={route} waitingCount={waitingItems.length} onNavigate={navigate} />
      <div className="workbench-body">
        <header className="workbench-topbar">
          <div>
            <p className="eyebrow">PERSONAL AI WORKBENCH</p>
            <h1 className="workbench-title">规划确认 → 专业执行 → 独立审查 → 用户验收</h1>
          </div>
          <section className={`service-card compact ${status.kind}`} aria-live="polite">
            <span className="status-dot" aria-hidden="true" />
            <div>
              <h2>{copy.label}</h2>
              <p>{copy.detail}</p>
            </div>
          </section>
        </header>

        <main id="workbench-main" className="workbench-main" tabIndex={-1}>
          {route.section === "home" && (
            <HomeDashboard
              counts={counts}
              waitingPreview={waitingItems}
              loading={dashboardLoading}
              error={dashboardError}
              onNavigate={navigate}
              onRefresh={() => void refreshDashboard()}
            />
          )}

          {route.section === "waiting" && (
            <WaitingOnMeCenter
              available={online}
              items={waitingItems}
              loading={dashboardLoading}
              error={dashboardError}
              onRefresh={() => void refreshDashboard()}
              onNavigate={navigate}
            />
          )}

          {route.section === "todos" && (
            <TodoBoard
              serviceUrl={serviceUrl}
              available={online}
              dataEpoch={dataEpoch}
              focusTodoId={route.todoId}
              onFocusTodo={(todoId) =>
                navigate(todoId ? { section: "todos", todoId } : { section: "todos" })
              }
            />
          )}

          {route.section === "projects" && (
            <ProjectsPanel serviceUrl={serviceUrl} available={online} dataEpoch={dataEpoch} />
          )}

          {route.section === "agents" && (
            <div className="stacked-panels">
              <RolesPanel serviceUrl={serviceUrl} available={online} dataEpoch={dataEpoch} />
              <RoleRouterPanel serviceUrl={serviceUrl} available={online} />
              <SessionPanel serviceUrl={serviceUrl} available={online} dataEpoch={dataEpoch} />
            </div>
          )}

          {route.section === "connections" && (
            <div className="stacked-panels">
              <ConnectionsPanel serviceUrl={serviceUrl} available={online} dataEpoch={dataEpoch} />
              <McpPanel serviceUrl={serviceUrl} available={online} dataEpoch={dataEpoch} />
            </div>
          )}

          {route.section === "documents" && (
            <DocumentWorkflowPanel serviceUrl={serviceUrl} available={online} />
          )}

          {route.section === "settings" && (
            <div className="stacked-panels">
              <QueueGuardPanel serviceUrl={serviceUrl} available={online} dataEpoch={dataEpoch} />
              <BackupPanel
                serviceUrl={serviceUrl}
                available={online}
                onImportSuccess={() => setDataEpoch((epoch) => epoch + 1)}
              />
              <PwaInstallGuidePanel serviceUrl={serviceUrl} />
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
