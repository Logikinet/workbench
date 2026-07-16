import { useCallback, useEffect, useState } from "react";
import {
  healthToStatus,
  serviceFailureStatus,
  serviceStatusCopy,
  type HealthResponse,
  type ServiceStatus
} from "./lib/serviceStatus.js";
import { ProjectWorkspace } from "./components/ProjectWorkspace.js";
import { ConnectionsPanel } from "./components/ConnectionsPanel.js";
import { McpPanel } from "./components/McpPanel.js";
import { BackupPanel } from "./components/BackupPanel.js";
import { PwaInstallGuidePanel } from "./components/PwaInstallGuidePanel.js";
import { WorkbenchNav } from "./components/WorkbenchNav.js";
import { ChatWorkspace } from "./components/ChatWorkspace.js";
import { WaitingOnMeCenter } from "./components/WaitingOnMeCenter.js";
import { DocumentWorkflowPanel } from "./components/DocumentWorkflowPanel.js";
import { SkillsPanel } from "./components/SkillsPanel.js";
import { TriggersPanel } from "./components/TriggersPanel.js";
import { TeamPanel } from "./components/TeamPanel.js";
import { SecretsPanel } from "./components/SecretsPanel.js";
import { MembersPanel } from "./components/MembersPanel.js";
import { CreateProjectModal } from "./components/CreateProjectModal.js";
import { TodoSidePanel } from "./components/TodoSidePanel.js";
import { TdsPage } from "./components/TdsPage.js";
import {
  formatWorkbenchHash,
  parseWorkbenchHash,
  routeMeta,
  type WorkbenchRoute
} from "./lib/workbenchRoutes.js";
import {
  loadWorkbenchDashboard,
  type WorkbenchDashboardSnapshot
} from "./lib/workbenchDashboard.js";
import { resolveRuntimeServiceUrl } from "./lib/serviceUrl.js";
import "./styles.css";

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
  return parseWorkbenchHash(window.location.hash || "#/chief");
}

export function App() {
  const [status, setStatus] = useState<ServiceStatus>({ kind: "offline" });
  const [dataEpoch, setDataEpoch] = useState(0);
  const [route, setRoute] = useState<WorkbenchRoute>(readRoute);
  const [dashboard, setDashboard] = useState<WorkbenchDashboardSnapshot | null>(null);
  const [dashboardLoading, setDashboardLoading] = useState(false);
  const [dashboardError, setDashboardError] = useState("");
  const [providersAddOpen, setProvidersAddOpen] = useState(false);
  const [createProjectOpen, setCreateProjectOpen] = useState(false);

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
    if (!window.location.hash) window.location.hash = "#/chief";
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`${serviceUrl}/api/health`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Service returned ${response.status}`);
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
      setDashboardError(error instanceof Error ? error.message : "Failed to load dashboard");
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
  const meta = routeMeta[route.section];
  const isChatHome = route.section === "home";
  /** todos: panel=todo:id drawer on any page except full todos detail already open */
  const panelTodoId =
    route.todoId && route.section !== "todos" ? route.todoId : undefined;
  /** todos pages own their headers — no extra chrome */
  const hideChromeHeader = true;
  void meta;
  void hideChromeHeader;

  return (
    <div className={`workbench-app tds-shell${panelTodoId ? " has-todo-panel" : ""}`}>
      <a className="skip-link" href="#workbench-main">
        跳到主内容
      </a>
      <WorkbenchNav
        route={route}
        waitingCount={waitingItems.length}
        statusKind={status.kind}
        statusLabel={copy.label}
        serviceUrl={serviceUrl}
        onNavigate={(next) => {
          setProvidersAddOpen(false);
          navigate(next);
        }}
        onNewProject={() => setCreateProjectOpen(true)}
      />
      <div className="workbench-body">
        <div className="tds-main-row">
          <main
            id="workbench-main"
            className={`workbench-main tds-main tds-main-v2${isChatHome ? " chat-main" : ""}`}
            tabIndex={-1}
          >
            {route.section === "home" && (
              <ChatWorkspace
                serviceUrl={serviceUrl}
                available={online}
                dataEpoch={dataEpoch}
                onOpenTodos={(todoId) =>
                  navigate(
                    todoId
                      ? { section: "home", todoId }
                      : { section: "todos" }
                  )
                }
              />
            )}

            {route.section === "waiting" && (
              <WaitingOnMeCenter
                available={online}
                serviceUrl={serviceUrl}
                items={waitingItems}
                loading={dashboardLoading}
                error={dashboardError}
                onRefresh={() => void refreshDashboard()}
                onNavigate={navigate}
              />
            )}

            {route.section === "todos" && (
              <ProjectWorkspace
                serviceUrl={serviceUrl}
                available={online}
                dataEpoch={dataEpoch}
                focusTodoId={route.todoId}
                onSelectTodo={(todoId) =>
                  navigate(todoId ? { section: "todos", todoId } : { section: "todos" })
                }
              />
            )}

            {route.section === "projects" && (
              <ProjectWorkspace
                serviceUrl={serviceUrl}
                available={online}
                dataEpoch={dataEpoch}
                projectId={route.projectId}
                focusTodoId={route.todoId}
                onSelectProject={(projectId) =>
                  navigate({ section: "projects", projectId, todoId: route.todoId })
                }
                onSelectTodo={(todoId) =>
                  navigate({
                    section: "projects",
                    projectId: route.projectId,
                    todoId
                  })
                }
              />
            )}

            {route.section === "connections" && (
              <ConnectionsPanel
                serviceUrl={serviceUrl}
                available={online}
                dataEpoch={dataEpoch}
                embedded
                addOpen={providersAddOpen}
                onAddOpenChange={setProvidersAddOpen}
              />
            )}

            {route.section === "skills" && (
              <TdsPage kicker="资源" title="技能" description="Skills 安装、信任与启用">
                <SkillsPanel serviceUrl={serviceUrl} available={online} dataEpoch={dataEpoch} />
              </TdsPage>
            )}

            {route.section === "secrets" && <SecretsPanel onNavigate={navigate} />}

            {route.section === "mcp" && (
              <TdsPage kicker="资源" title="MCP" description="Model Context Protocol">
                <McpPanel serviceUrl={serviceUrl} available={online} dataEpoch={dataEpoch} />
              </TdsPage>
            )}

            {route.section === "triggers" && (
              <TdsPage kicker="资源" title="触发器" description="定时 / 手动自动化">
                <TriggersPanel serviceUrl={serviceUrl} available={online} dataEpoch={dataEpoch} />
              </TdsPage>
            )}

            {route.section === "agents" && (
              <MembersPanel serviceUrl={serviceUrl} available={online} dataEpoch={dataEpoch} />
            )}

            {route.section === "team" && (
              <TeamPanel
                online={online}
                statusLabel={copy.label}
                serviceUrl={serviceUrl}
                counts={counts}
                waitingItems={waitingItems}
                onNavigate={navigate}
              />
            )}

            {route.section === "documents" && (
              <TdsPage kicker="资源" title="文档" description="文档产物">
                <DocumentWorkflowPanel serviceUrl={serviceUrl} available={online} />
              </TdsPage>
            )}

            {route.section === "settings" && (
              <>
                <MembersPanel serviceUrl={serviceUrl} available={online} dataEpoch={dataEpoch} />
                <div className="tds-settings-extra">
                  <BackupPanel
                    serviceUrl={serviceUrl}
                    available={online}
                    onImportSuccess={() => setDataEpoch((epoch) => epoch + 1)}
                  />
                  <PwaInstallGuidePanel serviceUrl={serviceUrl} />
                </div>
              </>
            )}
          </main>

          {panelTodoId ? (
            <TodoSidePanel
              serviceUrl={serviceUrl}
              available={online}
              todoId={panelTodoId}
              onClose={() => navigate({ section: route.section, projectId: route.projectId })}
            />
          ) : null}
        </div>
      </div>

      <CreateProjectModal
        open={createProjectOpen}
        serviceUrl={serviceUrl}
        available={online}
        onClose={() => setCreateProjectOpen(false)}
        onCreated={(projectId) => {
          setDataEpoch((epoch) => epoch + 1);
          setCreateProjectOpen(false);
          navigate({ section: "projects", projectId });
        }}
      />
    </div>
  );
}
