import { createApp } from "./http/app.js";
import { ProjectService } from "./projects/projectService.js";
import { WindowsFolderPicker, WorkspaceAuthorizer } from "./projects/workspaceAuthorization.js";
import { TodoService } from "./todos/todoService.js";
import { RunService } from "./runs/runService.js";
import { ConnectionService, WindowsCredentialVault } from "./connections/connectionService.js";
import { RoleService } from "./roles/roleService.js";
import { ProfessionalAgentService } from "./execution/professionalAgentService.js";
import { CodexCliService } from "./codex/codexCliService.js";
import { GitWorktreeService } from "./git/gitWorktreeService.js";
import { ReviewService } from "./review/reviewService.js";
import { createBackupService } from "./backup/createBackupWiring.js";
import { ResourceGuardService } from "./queue/resourceGuardService.js";
import { RunQueueService } from "./queue/runQueueService.js";
import { ModelRuntime } from "./model/modelRuntime.js";
import { AiPlanningService } from "./planning/aiPlanningService.js";
import { createVerificationService } from "./verification/verificationService.js";
import { RoleRouterService } from "./routing/roleRouterService.js";
import { SubtaskDagService } from "./subtasks/subtaskDagService.js";
import { ToolRegistry } from "./tools/toolRegistry.js";
import { SkillService } from "./skills/skillService.js";
import { CapabilityRuntime } from "./skills/capabilityRuntime.js";
import { McpService } from "./mcp/mcpService.js";
import { FirstmateSelfManagementService } from "./firstmate/firstmateSelfManagementService.js";
import { SessionService } from "./sessions/sessionService.js";
import { AutomationService } from "./automation/automationService.js";
import { AgentHomeService } from "./agentHome/agentHomeService.js";
import { homedir } from "node:os";
import { join } from "node:path";

async function main(): Promise<void> {
  const port = Number.parseInt(process.env.PAW_SERVICE_PORT ?? "41731", 10);
  const dataDirectory = process.env.PAW_DATA_DIR ?? join(process.env.LOCALAPPDATA ?? homedir(), "PersonalAIWorkbench");
  const serviceVersion = process.env.PAW_SERVICE_VERSION ?? "0.1.0";
  const projects = await ProjectService.open(
    join(dataDirectory, "state.json"),
    new WorkspaceAuthorizer(new WindowsFolderPicker())
  );
  const todos = await TodoService.open(join(dataDirectory, "todos.json"), projects);
  const runs = await RunService.open(join(dataDirectory, "runs.json"), todos);
  const connections = await ConnectionService.open(
    join(dataDirectory, "connections.json"),
    new WindowsCredentialVault(),
    fetch,
    (connectionId, reason) => runs.pauseForConnection(connectionId, reason).then(() => undefined)
  );
  const roles = await RoleService.open(join(dataDirectory, "roles.json"), connections);
  const worktrees = await GitWorktreeService.open(join(dataDirectory, "worktrees.json"));
  const resourceGuard = new ResourceGuardService(dataDirectory);
  const queue = await RunQueueService.open({
    statePath: join(dataDirectory, "queue.json"),
    resourceGuard,
    runs,
    onTimeout: async (runId, reason) => {
      await runs.transition(runId, "paused", reason);
    }
  });
  const professionalAgents = new ProfessionalAgentService({ projects, todos, runs, roles, connections, queue });
  const codexCli = new CodexCliService({ projects, todos, runs, roles, worktrees, queue });
  const modelRuntime = new ModelRuntime({
    roles,
    connections,
    runHooks: {
      recordLog: (runId, input) => runs.recordLog(runId, input),
      pause: (runId, reason) => runs.transition(runId, "paused", reason)
    }
  });
  const roleList = await roles.list();
  const firstmateRole =
    roleList.find((role) => /firstmate/i.test(role.name)) ??
    roleList.find((role) => role.harness === "api" && role.enabled);
  const secondmateRole =
    roleList.find((role) => /secondmate/i.test(role.name)) ??
    roleList.find((role) => role.id !== firstmateRole?.id && role.harness === "api" && role.enabled) ??
    firstmateRole;
  // Task 28: Reviewer model/role is configured separately from the executor Professional Agent.
  const reviewerRole =
    roleList.find((role) => /reviewer|no-mistakes|审查/i.test(role.name)) ??
    roleList.find((role) => role.skills?.includes("code-review") && role.harness === "api" && role.enabled) ??
    firstmateRole;
  const reviews = new ReviewService({
    runs,
    todos,
    modelRuntime,
    reviewerRoleId: reviewerRole?.id,
    dispatchFixAgent: async (runId, _instruction) => {
      const run = await runs.get(runId);
      if (run.execution.selectedAgent?.harness === "codex-cli") {
        return codexCli.start(runId, {});
      }
      return professionalAgents.start(runId, {});
    }
  });
  const backup = createBackupService({
    dataDirectory,
    projects,
    todos,
    runs,
    roles,
    connections,
    appVersion: serviceVersion
  });
  const aiPlanning =
    firstmateRole && secondmateRole
      ? new AiPlanningService({
          modelRuntime,
          firstmateRoleId: firstmateRole.id,
          secondmateRoleId: secondmateRole.id
        })
      : undefined;

  // Task 18: AI is default planning path when API roles exist; template remains fallback.
  if (aiPlanning) {
    runs.configurePlanning({
      aiPlanning,
      resolveProject: async (todoId) => {
        const todo = await todos.get(todoId);
        if (!todo.projectId) return undefined;
        try {
          const project = await projects.get(todo.projectId);
          return {
            id: project.id,
            name: project.name,
            summary: project.summary,
            workspacePath: project.workspacePath
          };
        } catch {
          return undefined;
        }
      }
    });
  }

  const verification = createVerificationService();
  const roleRouter = new RoleRouterService({ roles, connections });
  const subtasks = await SubtaskDagService.open(join(dataDirectory, "subtasks.json"), {
    roleRouter
  });
  const tools = await ToolRegistry.open({ statePath: join(dataDirectory, "tools.json") });
  const skills = await SkillService.open({ statePath: join(dataDirectory, "skills.json") });
  const capabilityRuntime = new CapabilityRuntime({ skills, tools });
  const mcp = await McpService.open({
    statePath: join(dataDirectory, "mcp.json"),
    vault: new WindowsCredentialVault()
  });

  const firstmate = new FirstmateSelfManagementService({
    roles,
    connections,
    skills,
    tools,
    projects,
    runs,
    queue
  });
  const sessions = await SessionService.open(join(dataDirectory, "sessions.json"));
  const automation = await AutomationService.open({
    statePath: join(dataDirectory, "automation.json"),
    todos,
    runs
  });
  await automation.start();
  const agentHomes = await AgentHomeService.open({
    longTermRoot: join(dataDirectory, "agent-homes"),
    tempRoot: join(dataDirectory, "agent-homes-temp")
  });
  void agentHomes;

  const webRoot = process.env.PAW_WEB_DIST?.trim() || undefined;
  const app = createApp({
    version: serviceVersion,
    webRoot,
    projects,
    todos,
    runs,
    connections,
    roles,
    professionalAgents,
    codexCli,
    worktrees,
    verification,
    roleRouter,
    subtasks,
    tools,
    skills,
    capabilityRuntime,
    mcp,
    firstmate,
    sessions,
    automation,
    reviews,
    backup,
    queue,
    aiPlanning
  });

  // Bind loopback only — never expose the Agent Service on LAN interfaces.
  app.listen(port, "127.0.0.1", () => {
    console.info(`Personal AI Workbench service listening on http://127.0.0.1:${port}`);
    if (webRoot) {
      console.info(`Serving installed PWA from ${webRoot}`);
    }
  });
}

void main();
