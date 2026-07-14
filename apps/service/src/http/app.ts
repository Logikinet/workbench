import express, { type Express, type Request, type Response } from "express";
import type { ProjectService, ProjectStatus } from "../projects/projectService.js";
import { todoStatuses, type TodoService, type TodoStatus } from "../todos/todoService.js";
import {
  captureWorkspaceFingerprint,
  runStatuses,
  taskTypes,
  type CorrectionChangeKind,
  type RunService,
  type RunStatus,
  type TaskType,
  type WorkspaceFingerprint
} from "../runs/runService.js";
import type { ConnectionService, ModelConnection } from "../connections/connectionService.js";
import type { AgentRole, CreateRoleInput, RoleService, UpdateRoleInput } from "../roles/roleService.js";
import type { ProfessionalAgentService, StartProfessionalAgentInput, TemporaryProfessionalAgentInput } from "../execution/professionalAgentService.js";
import type { CodexCliService } from "../codex/codexCliService.js";
import {
  assessWorktreeArtifactConsistency,
  findCodexWorktreeEvidence
} from "../codex/codexArtifactIndex.js";
import type { GitWorktreeService } from "../git/gitWorktreeService.js";
import { registerWorktreeApplyRoutes } from "../git/worktreeRoutes.js";
import { mountConnectionRoutes } from "../connections/connectionRoutes.js";
import { mountProviderRoutes } from "../providers/providerRoutes.js";
import { createPlanningRouter } from "../planning/planningRoutes.js";
import type { AiPlanningService } from "../planning/aiPlanningService.js";
import { createAskUserRouter } from "../askUser/askUserRoutes.js";
import type { ReviewService } from "../review/reviewService.js";
import type { BackupService } from "../backup/backupService.js";
import type { QueueConfigUpdate, RunQueueService } from "../queue/runQueueService.js";

export type ClientAddressResolver = (request: Request) => string | undefined;

export interface ServiceAppOptions {
  version: string;
  clientAddress?: ClientAddressResolver;
  /** Optional built PWA dist directory served on the same loopback origin as the API. */
  webRoot?: string;
  projects?: ProjectService;
  todos?: TodoService;
  runs?: RunService;
  connections?: ConnectionService;
  roles?: RoleService;
  professionalAgents?: ProfessionalAgentService;
  codexCli?: CodexCliService;
  worktrees?: Pick<
    GitWorktreeService,
    "get" | "captureDiff" | "runApprovedChecks" | "discard" | "previewApply" | "applyToMain" | "keepPending"
  >;
  reviews?: ReviewService;
  backup?: BackupService;
  queue?: RunQueueService;
  /** Task 18: AI Firstmate/Secondmate planning (optional until ModelRuntime is wired). */
  aiPlanning?: AiPlanningService;
}

const loopbackAddresses = new Set(["127.0.0.1", "::1", "localhost"]);

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return loopbackAddresses.has(address.replace("::ffff:", ""));
}

function isLocalOrigin(origin: string): boolean {
  try {
    return loopbackAddresses.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

export function createApp(options: ServiceAppOptions): Express {
  const app = express();
  const clientAddress = options.clientAddress ?? ((request) => request.socket.remoteAddress);

  app.disable("x-powered-by");
  // Keep a modest default JSON limit for ordinary routes; backup import may carry full Run history.
  const defaultJsonParser = express.json({ limit: "1mb" });
  const backupImportJsonParser = express.json({ limit: "50mb" });
  app.use((request, response, next) => {
    if (request.method === "POST" && (request.path === "/api/backup/import" || request.url.startsWith("/api/backup/import"))) {
      return backupImportJsonParser(request, response, next);
    }
    return defaultJsonParser(request, response, next);
  });
  app.use((request, response, next) => {
    if (!isLoopbackAddress(clientAddress(request))) {
      response.status(403).json({ error: "This service accepts local connections only." });
      return;
    }

    const origin = request.header("origin");
    if (origin && !isLocalOrigin(origin)) {
      response.status(403).json({ error: "This service accepts local origins only." });
      return;
    }
    if (origin) {
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Vary", "Origin");
      response.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
      response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    }
    if (request.method === "OPTIONS") {
      response.status(204).end();
      return;
    }
    next();
  });

  app.get("/api/health", (_request, response) => {
    response.json({
      status: "online",
      version: options.version,
      capabilities: [
        "projects",
        "todos",
        "backup",
        "queue",
        ...(options.connections ? (["connections", "providers"] as const) : []),
        ...(options.worktrees ? (["worktree-apply"] as const) : []),
        ...(options.aiPlanning ? (["ai-planning"] as const) : []),
        ...(options.runs ? (["ask-user"] as const) : [])
      ]
    });
  });

  // Task 39: enhanced connection diagnostics + provider presets (no secrets in responses).
  if (options.connections) {
    mountConnectionRoutes(app, options.connections);
    mountProviderRoutes(app);
  }

  // Task 18: optional AI planning endpoint (does not mutate formal files).
  if (options.aiPlanning && options.runs && options.todos) {
    app.use(
      createPlanningRouter({
        aiPlanning: options.aiPlanning,
        runs: options.runs,
        todos: options.todos,
        projects: options.projects
      })
    );
  }

  // Task 19: structured AskUser / AskApproval / AskReplan cards.
  if (options.runs) {
    app.use(createAskUserRouter(options.runs));
  }

  app.get("/api/queue/config", async (_request, response) => {
    if (!options.queue) return response.status(503).json({ error: "Queue service is not ready." });
    response.json(options.queue.getConfig());
  });

  app.put("/api/queue/config", async (request, response) => {
    if (!options.queue) return response.status(503).json({ error: "Queue service is not ready." });
    try {
      response.json(await options.queue.updateConfig(parseQueueConfigUpdate(request.body)));
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "Unable to update queue config." });
    }
  });

  app.get("/api/queue/status", async (_request, response) => {
    if (!options.queue) return response.status(503).json({ error: "Queue service is not ready." });
    try {
      response.json(await options.queue.status());
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "Unable to read queue status." });
    }
  });

  app.post("/api/runs/stop-all", async (request, response) => {
    if (!options.queue) return response.status(503).json({ error: "Queue service is not ready." });
    const summary = typeof request.body?.summary === "string" ? request.body.summary : "用户一键停止全部 Run。";
    try {
      response.json(await options.queue.stopAll(summary));
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "Unable to stop all Runs." });
    }
  });

  app.get("/api/projects", async (_request, response) => {
    if (!options.projects) return response.status(503).json({ error: "Project service is not ready." });
    response.json(await options.projects.list());
  });

  app.post("/api/workspace-authorizations", async (request, response) => {
    if (!options.projects) return response.status(503).json({ error: "Project service is not ready." });
    try {
      const authorization = await options.projects.requestWorkspaceAuthorization(
        typeof request.body?.workspacePath === "string" ? request.body.workspacePath : ""
      );
      response.status(201).json(authorization);
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "Unable to confirm workspace." });
    }
  });

  app.post("/api/projects", async (request, response) => {
    if (!options.projects) return response.status(503).json({ error: "Project service is not ready." });
    try {
      const project = await options.projects.create({
        name: typeof request.body?.name === "string" ? request.body.name : "",
        workspacePath: typeof request.body?.workspacePath === "string" ? request.body.workspacePath : "",
        summary: typeof request.body?.summary === "string" ? request.body.summary : undefined,
        authorizationGrantId:
          typeof request.body?.authorizationGrantId === "string" ? request.body.authorizationGrantId : ""
      });
      response.status(201).json(project);
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "Unable to create Project." });
    }
  });

  app.patch("/api/projects/:projectId", async (request, response) => {
    if (!options.projects) return response.status(503).json({ error: "Project service is not ready." });
    const status = request.body?.status;
    if (status !== undefined && status !== "active" && status !== "archived") {
      return response.status(400).json({ error: "Project status must be active or archived." });
    }
    try {
      const project = await options.projects.update(request.params.projectId, {
        name: typeof request.body?.name === "string" ? request.body.name : undefined,
        summary: typeof request.body?.summary === "string" ? request.body.summary : undefined,
        status: status as ProjectStatus | undefined
      });
      response.json(project);
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "Unable to update Project." });
    }
  });

  app.get("/api/todos", async (request, response) => {
    if (!options.todos) return response.status(503).json({ error: "Todo service is not ready." });
    const status = typeof request.query.status === "string" ? request.query.status : undefined;
    if (status && !todoStatuses.includes(status as TodoStatus)) {
      return response.status(400).json({ error: "Todo status is invalid." });
    }
    response.json(
      await options.todos.list({
        status: status as TodoStatus | undefined,
        query: typeof request.query.query === "string" ? request.query.query : undefined,
        archived: request.query.archived === "true"
      })
    );
  });

  app.post("/api/todos", async (request, response) => {
    if (!options.todos) return response.status(503).json({ error: "Todo service is not ready." });
    try {
      const todo = await options.todos.create({
        title: typeof request.body?.title === "string" ? request.body.title : "",
        description: typeof request.body?.description === "string" ? request.body.description : undefined,
        projectId: typeof request.body?.projectId === "string" ? request.body.projectId : undefined
      });
      response.status(201).json(todo);
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "Unable to create Todo." });
    }
  });

  app.patch("/api/todos/:todoId", async (request, response) => {
    if (!options.todos) return response.status(503).json({ error: "Todo service is not ready." });
    const status = request.body?.status;
    if (status !== undefined && (!todoStatuses.includes(status) || typeof status !== "string")) {
      return response.status(400).json({ error: "Todo status is invalid." });
    }
    if (request.body?.archived !== undefined && typeof request.body.archived !== "boolean") {
      return response.status(400).json({ error: "Todo archived must be a boolean." });
    }
    // Clients cannot forge formal acceptance; only the review acceptance endpoint may complete a Todo.
    if (status === "completed") {
      return response.status(400).json({
        error: "Todo completion requires a passed independent review and user acceptance via the Run acceptance endpoint."
      });
    }
    try {
      const todo = await options.todos.update(request.params.todoId, {
        title: typeof request.body?.title === "string" ? request.body.title : undefined,
        description: typeof request.body?.description === "string" ? request.body.description : undefined,
        projectId:
          typeof request.body?.projectId === "string" || request.body?.projectId === null
            ? request.body.projectId
            : undefined,
        status: status as TodoStatus | undefined,
        archived: request.body?.archived
      });
      response.json(todo);
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "Unable to update Todo." });
    }
  });

  app.get("/api/todos/:todoId/runs", async (request, response) => {
    if (!options.runs) return response.status(503).json({ error: "Run service is not ready." });
    try {
      response.json(await options.runs.listForTodo(request.params.todoId));
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "Unable to list Runs." });
    }
  });

  app.post("/api/todos/:todoId/runs", async (request, response) => {
    if (!options.runs) return response.status(503).json({ error: "Run service is not ready." });
    try {
      const run = await options.runs.create(
        request.params.todoId,
        typeof request.body?.message === "string" ? request.body.message : undefined,
        typeof request.body?.connectionId === "string" ? request.body.connectionId : undefined
      );
      response.status(201).json(run);
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "Unable to create Run." });
    }
  });

  app.get("/api/runs/:runId", async (request, response) => {
    if (!options.runs) return response.status(503).json({ error: "Run service is not ready." });
    try {
      response.json(await options.runs.get(request.params.runId));
    } catch (error) {
      response.status(404).json({ error: error instanceof Error ? error.message : "Run was not found." });
    }
  });

  app.get("/api/interrupted-runs", async (_request, response) => {
    if (!options.runs) return response.status(503).json({ error: "Run service is not ready." });
    response.json(await options.runs.listInterruptedRuns());
  });

  app.get("/api/runs/:runId/checkpoints", async (request, response) => {
    if (!options.runs) return response.status(503).json({ error: "Run service is not ready." });
    try {
      const run = await options.runs.get(request.params.runId);
      const checkpoints = await options.runs.listCheckpoints(request.params.runId);
      response.json({
        runId: run.id,
        status: run.status,
        completedSteps: run.execution.completedSteps,
        activeStep: run.execution.activeStep,
        checkpointRecovery: run.checkpointRecovery,
        checkpoints,
        recoveryNote: run.checkpointRecovery?.recoveryNote
          ?? "恢复通过批准计划与最近检查点重建模型会话上下文；不会恢复原模型内部会话状态。"
      });
    } catch (error) {
      response.status(404).json({ error: error instanceof Error ? error.message : "Run was not found." });
    }
  });

  app.post("/api/runs/:runId/checkpoint-resume", async (request, response) => {
    if (!options.runs) return response.status(503).json({ error: "Run service is not ready." });
    try {
      const runId = request.params.runId;
      const run = await options.runs.get(runId);
      let currentFingerprint = parseWorkspaceFingerprint(request.body?.workspaceFingerprint);
      if (!currentFingerprint && options.projects && options.todos) {
        const todo = await options.todos.get(run.todoId);
        if (todo.projectId) {
          const project = await options.projects.get(todo.projectId);
          currentFingerprint = await captureWorkspaceFingerprint(
            project.workspacePath,
            run.artifacts.map((artifact) => artifact.path)
          );
        }
      }
      const result = await options.runs.resumeFromCheckpoint(runId, {
        currentFingerprint,
        approveDangerousReplay: request.body?.approveDangerousReplay === true
      });
      if (!result.canContinue) {
        return response.status(result.conflict ? 409 : 403).json({
          ...result,
          error: result.reason ?? (result.conflict ? "工作区冲突，恢复已暂停。" : "需要确认危险步骤后才能恢复。")
        });
      }

      // Rebuild model session by re-invoking the original harness — never claim restored model internals.
      let continued = result.run;
      if (result.run.execution.selectedAgent?.harness === "codex-cli") {
        if (options.codexCli) continued = await options.codexCli.start(runId, {});
      } else if (result.run.execution.selectedAgent) {
        if (options.professionalAgents) continued = await options.professionalAgents.start(runId, {});
      }
      response.status(202).json({
        ...result,
        run: continued,
        resumePlan: result.resumePlan
      });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "Unable to resume from checkpoint." });
    }
  });

  app.get("/api/runs/:runId/worktree", async (request, response) => {
    if (!options.worktrees || !options.runs) return response.status(503).json({ error: "Git worktree and Run services are not ready." });
    try {
      const runId = request.params.runId;
      let run = await options.runs.get(runId);
      let session: Awaited<ReturnType<GitWorktreeService["get"]>> | null = null;
      let changedFiles: string[] = [];
      let diff = "";
      try {
        session = await options.worktrees.get(runId);
      } catch {
        session = null;
      }

      const assessment = assessWorktreeArtifactConsistency(run, session);
      if (assessment.needsUpdate) {
        run = await options.runs.reconcileWorktreeArtifactConsistency(runId, {
          sessionStatus: assessment.sessionStatus,
          consistency: assessment.consistency,
          consistencyNote: assessment.consistencyNote
        });
      }

      if (session?.status === "active") {
        const captured = await options.worktrees.captureDiff(runId);
        changedFiles = captured.changedFiles;
        diff = captured.diff;
      } else if (session?.status === "discarded") {
        // History lives on the normalized artifact evidence after discard.
        const evidence = findCodexWorktreeEvidence(run);
        changedFiles = evidence?.changedFiles ?? [];
        diff = evidence?.diff ?? "";
      } else {
        const evidence = findCodexWorktreeEvidence(run);
        changedFiles = evidence?.changedFiles ?? [];
        diff = evidence?.diff ?? "";
      }

      const evidence = findCodexWorktreeEvidence(run);
      response.json({
        session: session ?? {
          runId,
          status: "missing" as const,
          workspacePath: evidence?.worktreePath ?? "",
          mainWorkspacePath: "",
          verificationResults: evidence?.verificationResults ?? []
        },
        changedFiles,
        diff,
        /** Same normalized result Reviewer uses — not log keyword scraping. */
        artifactEvidence: evidence ?? null,
        consistency: evidence?.consistency ?? assessment.consistency,
        consistencyNote: evidence?.consistencyNote ?? assessment.consistencyNote
      });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "Unable to read Git worktree diff." });
    }
  });

  app.post("/api/runs/:runId/worktree/checks", async (request, response) => {
    if (!options.worktrees || !options.runs) return response.status(503).json({ error: "Git worktree and Run services are not ready." });
    const commands = request.body?.commands;
    if (!Array.isArray(commands) || commands.length === 0 || commands.some((command) => !Array.isArray(command) || command.some((part) => typeof part !== "string"))) {
      return response.status(400).json({ error: "Checks must be a non-empty array of command argument arrays." });
    }
    try {
      const run = await options.runs.get(request.params.runId);
      if (run.status === "running" || run.execution.status === "running" || run.execution.terminationUnconfirmed) {
        return response.status(409).json({ error: "An active or unconfirmed execution must stop before isolated checks can run." });
      }
      const approvedPlan = run.planVersions.find((plan) => plan.version === run.planning?.approvedPlanVersion);
      const approvedCommands = approvedPlan?.verificationCommands ?? [];
      if (!commands.every((command) => approvedCommands.some((approved) => sameCommand(command, approved)))) {
        return response.status(400).json({ error: "Only verification commands in the approved Secondmate plan may run." });
      }
      response.status(201).json(await options.worktrees.runApprovedChecks(request.params.runId, commands));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to run isolated checks.";
      response.status(isWorktreeBusyConflict(message) ? 409 : 400).json({ error: message });
    }
  });

  app.delete("/api/runs/:runId/worktree", async (request, response) => {
    if (!options.worktrees || !options.runs) return response.status(503).json({ error: "Git worktree and Run services are not ready." });
    try {
      const run = await options.runs.get(request.params.runId);
      if (run.status === "running" || run.execution.status === "running" || run.execution.terminationUnconfirmed) {
        return response.status(409).json({ error: "An active or unconfirmed execution must stop before its Worktree can be discarded." });
      }
      const session = await options.worktrees.discard(request.params.runId);
      // Keep Diff/evidence history on the Run; mark discarded for Reviewer/PWA.
      await options.runs.markWorktreeArtifactsDiscarded(request.params.runId);
      response.json(session);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to discard Git worktree.";
      response.status(isWorktreeBusyConflict(message) ? 409 : 400).json({ error: message });
    }
  });

  // Task 27: accept apply / keep-pending (preview + merge into main; never auto-push).
  if (options.worktrees) {
    registerWorktreeApplyRoutes(app, {
      worktrees: options.worktrees,
      runs: options.runs
        ? {
            get: (runId) => options.runs!.get(runId),
            markWorktreeArtifactsDiscarded: (runId) => options.runs!.markWorktreeArtifactsDiscarded(runId)
          }
        : undefined
    });
  }

  app.post("/api/runs/:runId/messages", async (request, response) => {
    if (!options.runs) return response.status(503).json({ error: "Run service is not ready." });
    try {
      response.status(201).json(
        await options.runs.addUserMessage(
          request.params.runId,
          typeof request.body?.content === "string" ? request.body.content : ""
        )
      );
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "Unable to append message." });
    }
  });

  app.post("/api/runs/:runId/plan-versions", async (request, response) => {
    if (!options.runs) return response.status(503).json({ error: "Run service is not ready." });
    if (request.body?.version !== undefined || request.body?.summary !== undefined) {
      return response.status(400).json({ error: "Plan versions are generated by Secondmate; submit planning context instead." });
    }
    if (request.body?.revisionNote !== undefined && typeof request.body.revisionNote !== "string") {
      return response.status(400).json({ error: "Plan revision note must be text." });
    }
    try {
      response.status(201).json(await options.runs.recordPlanVersion(request.params.runId, { revisionNote: request.body?.revisionNote }));
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "Unable to record plan." });
    }
  });

  app.patch("/api/runs/:runId/planning", async (request, response) => {
    if (!options.runs) return response.status(503).json({ error: "Run service is not ready." });
    const taskType = request.body?.taskType;
    if (taskType !== undefined && (typeof taskType !== "string" || !taskTypes.includes(taskType as TaskType))) {
      return response.status(400).json({ error: "Task type is invalid." });
    }
    const requiredCapabilities = request.body?.requiredCapabilities;
    if (requiredCapabilities !== undefined && (!Array.isArray(requiredCapabilities) || requiredCapabilities.some((value) => typeof value !== "string"))) {
      return response.status(400).json({ error: "Required capabilities must be a string array." });
    }
    if (request.body?.additionalContext !== undefined && typeof request.body.additionalContext !== "string") {
      return response.status(400).json({ error: "Additional planning context must be text." });
    }
    try {
      response.json(await options.runs.updatePlanning(request.params.runId, {
        taskType: taskType as TaskType | undefined,
        requiredCapabilities,
        additionalContext: request.body?.additionalContext
      }));
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "Unable to update planning." });
    }
  });

  app.post("/api/runs/:runId/plan-decisions", async (request, response) => {
    if (!options.runs) return response.status(503).json({ error: "Run service is not ready." });
    const decision = request.body?.decision;
    const summary = request.body?.summary;
    if ((decision !== "approved" && decision !== "returned" && decision !== "cancelled") || typeof summary !== "string") {
      return response.status(400).json({ error: "Plan decision and summary are required." });
    }
    try {
      response.json(await options.runs.decidePlan(request.params.runId, { decision, summary }));
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "Unable to decide plan." });
    }
  });

  app.post("/api/runs/:runId/professional-agent/execute", async (request, response) => {
    if (!options.professionalAgents) return response.status(503).json({ error: "Professional Agent service is not ready." });
    try {
      response.status(202).json(await options.professionalAgents.start(request.params.runId, parseProfessionalAgentInput(request.body)));
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "Unable to start Professional Agent." });
    }
  });

  app.get("/api/codex-cli/status", async (_request, response) => {
    if (!options.codexCli) return response.status(503).json({ error: "Codex CLI service is not ready." });
    try {
      response.json(await options.codexCli.status());
    } catch {
      response.json({
        installed: false,
        authenticated: false,
        reason: "无法检测 Codex CLI。请检查本机安装和登录状态后重试。"
      });
    }
  });

  app.post("/api/runs/:runId/codex-cli/execute", async (request, response) => {
    if (!options.codexCli) return response.status(503).json({ error: "Codex CLI service is not ready." });
    if (request.body?.roleId !== undefined && typeof request.body.roleId !== "string") {
      return response.status(400).json({ error: "Codex CLI Role ID must be text." });
    }
    try {
      response.status(202).json(await options.codexCli.start(request.params.runId, {
        roleId: typeof request.body?.roleId === "string" ? request.body.roleId : undefined
      }));
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "Unable to start Codex CLI." });
    }
  });

  app.post("/api/runs/:runId/corrections", async (request, response) => {
    if (!options.runs) return response.status(503).json({ error: "Run service is not ready." });
    const instruction = request.body?.instruction;
    const changeKind = request.body?.changeKind;
    if (typeof instruction !== "string" || (changeKind !== undefined && !isCorrectionChangeKind(changeKind))) {
      return response.status(400).json({ error: "Correction instruction and change kind are invalid." });
    }
    try {
      const input = {
        instruction,
        changeKind: changeKind as CorrectionChangeKind | undefined
      };
      const run = await options.runs.get(request.params.runId);
      const result = run.execution.selectedAgent?.harness === "codex-cli"
        ? await startCodexCorrection(options.codexCli, request.params.runId, input)
        : await startProfessionalCorrection(options.professionalAgents, request.params.runId, input);
      response.status(result.continued ? 202 : 200).json(result.run);
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "Unable to apply correction." });
    }
  });

  app.post("/api/runs/:runId/stop", async (request, response) => {
    if (!options.runs) return response.status(503).json({ error: "Run service is not ready." });
    const summary = typeof request.body?.summary === "string" ? request.body.summary : "用户停止此 Run。";
    try {
      response.json(await options.runs.stop(request.params.runId, summary));
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "Unable to stop Run." });
    }
  });

  app.post("/api/runs/:runId/execution-approvals", async (request, response) => {
    if (!options.runs) return response.status(503).json({ error: "Run service is not ready." });
    const decision = request.body?.decision;
    const summary = request.body?.summary;
    if ((decision !== "approved" && decision !== "rejected") || typeof summary !== "string") {
      return response.status(400).json({ error: "Execution approval decision and summary are required." });
    }
    try {
      response.json(await options.runs.decideExecutionApproval(request.params.runId, { decision, summary }));
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "Unable to decide execution approval." });
    }
  });

  app.post("/api/runs/:runId/approvals", async (request, response) => {
    if (!options.runs) return response.status(503).json({ error: "Run service is not ready." });
    const decision = request.body?.decision;
    const summary = request.body?.summary;
    if ((decision !== "approved" && decision !== "returned" && decision !== "cancelled") || typeof summary !== "string") {
      return response.status(400).json({ error: "Approval decision and summary are required." });
    }
    try {
      response.status(201).json(await options.runs.recordApproval(request.params.runId, { decision, summary }));
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "Unable to record approval." });
    }
  });

  app.post("/api/runs/:runId/status", async (request, response) => {
    if (!options.runs) return response.status(503).json({ error: "Run service is not ready." });
    const status = request.body?.status;
    const summary = request.body?.summary;
    if (typeof status !== "string" || !runStatuses.includes(status as RunStatus) || typeof summary !== "string") {
      return response.status(400).json({ error: "Run status and summary are required." });
    }
    try {
      response.status(201).json(await options.runs.transition(request.params.runId, status as RunStatus, summary));
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "Unable to update Run status." });
    }
  });

  app.post("/api/runs/:runId/logs", async (request, response) => {
    if (!options.runs) return response.status(503).json({ error: "Run service is not ready." });
    const level = request.body?.level;
    const message = request.body?.message;
    if ((level !== "info" && level !== "warn" && level !== "error") || typeof message !== "string") {
      return response.status(400).json({ error: "Log level and message are required." });
    }
    try {
      response.status(201).json(await options.runs.recordLog(request.params.runId, { level, message }));
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "Unable to record log." });
    }
  });

  app.post("/api/runs/:runId/reviews", async (request, response) => {
    if (!options.runs) return response.status(503).json({ error: "Run service is not ready." });
    const status = request.body?.status;
    const summary = request.body?.summary;
    if ((status !== "passed" && status !== "changes_requested") || typeof summary !== "string") {
      return response.status(400).json({ error: "Review status and summary are required." });
    }
    try {
      response.status(201).json(await options.runs.recordReview(request.params.runId, { status, summary }));
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "Unable to record review." });
    }
  });

  app.get("/api/runs/:runId/review/context", async (request, response) => {
    if (!options.reviews) return response.status(503).json({ error: "Review service is not ready." });
    try {
      response.json(await options.reviews.getContext(request.params.runId));
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "Unable to assemble review context." });
    }
  });

  app.post("/api/runs/:runId/review/perform", async (request, response) => {
    if (!options.reviews) return response.status(503).json({ error: "Review service is not ready." });
    try {
      const autoDispatchFix = request.body?.autoDispatchFix;
      const result = await options.reviews.performReview(request.params.runId, {
        autoDispatchFix: typeof autoDispatchFix === "boolean" ? autoDispatchFix : undefined
      });
      response.status(201).json(result);
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "Unable to perform independent review." });
    }
  });

  app.post("/api/runs/:runId/review/fix", async (request, response) => {
    if (!options.reviews) return response.status(503).json({ error: "Review service is not ready." });
    try {
      const userAuthorized = request.body?.userAuthorized === true || request.body?.force === true;
      const result = await options.reviews.dispatchFix(request.params.runId, { userAuthorized });
      response.status(result.continued ? 202 : 200).json(result);
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "Unable to dispatch review fix." });
    }
  });

  app.post("/api/runs/:runId/acceptance", async (request, response) => {
    if (!options.reviews) return response.status(503).json({ error: "Review service is not ready." });
    const decision = request.body?.decision;
    const summary = request.body?.summary;
    if ((decision !== "accepted" && decision !== "rejected") || typeof summary !== "string") {
      return response.status(400).json({ error: "Acceptance decision and summary are required." });
    }
    try {
      // Task 27: development Runs with unapplied Worktree changes cannot formally complete.
      if (decision === "accepted" && options.worktrees) {
        try {
          const preview = await options.worktrees.previewApply(request.params.runId);
          if (!preview.canCompleteDevRun) {
            return response.status(409).json({
              error: "开发型修改尚未应用到主工作区：请先「接受应用」或「放弃修改」后再验收完成。",
              preview
            });
          }
        } catch {
          // No worktree session → gate open (non-code Runs).
        }
      }
      const result = decision === "accepted"
        ? await options.reviews.accept(request.params.runId, summary)
        : await options.reviews.reject(request.params.runId, summary);
      response.json(result);
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "Unable to record acceptance decision." });
    }
  });

  app.post("/api/runs/:runId/artifacts", async (request, response) => {
    if (!options.runs) return response.status(503).json({ error: "Run service is not ready." });
    const path = request.body?.path;
    const kind = request.body?.kind;
    if (typeof path !== "string" || typeof kind !== "string" || !path.trim() || !kind.trim()) {
      return response.status(400).json({ error: "Artifact path and kind are required." });
    }
    try {
      response.status(201).json(await options.runs.recordArtifact(request.params.runId, { path, kind }));
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "Unable to record artifact." });
    }
  });

  app.get("/api/connections", async (_request, response) => {
    if (!options.connections) return response.status(503).json({ error: "Connection service is not ready." });
    response.json((await options.connections.list()).map(toPublicConnection));
  });

  app.post("/api/connections", async (request, response) => {
    if (!options.connections) return response.status(503).json({ error: "Connection service is not ready." });
    try {
      response.status(201).json(toPublicConnection(await options.connections.create({
        name: typeof request.body?.name === "string" ? request.body.name : undefined,
        baseUrl: typeof request.body?.baseUrl === "string" ? request.body.baseUrl : "",
        apiKey: typeof request.body?.apiKey === "string" ? request.body.apiKey : "",
        modelId: typeof request.body?.modelId === "string" ? request.body.modelId : "",
        enabled: typeof request.body?.enabled === "boolean" ? request.body.enabled : undefined
      })));
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "Unable to save connection." });
    }
  });

  app.patch("/api/connections/:connectionId", async (request, response) => {
    if (!options.connections) return response.status(503).json({ error: "Connection service is not ready." });
    try {
      response.json(toPublicConnection(await options.connections.update(request.params.connectionId, {
        name: typeof request.body?.name === "string" ? request.body.name : undefined,
        baseUrl: typeof request.body?.baseUrl === "string" ? request.body.baseUrl : undefined,
        apiKey: typeof request.body?.apiKey === "string" ? request.body.apiKey : undefined,
        modelId: typeof request.body?.modelId === "string" ? request.body.modelId : undefined,
        enabled: typeof request.body?.enabled === "boolean" ? request.body.enabled : undefined
      })));
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "Unable to update connection." });
    }
  });

  app.delete("/api/connections/:connectionId", async (request, response) => {
    if (!options.connections) return response.status(503).json({ error: "Connection service is not ready." });
    try {
      await options.connections.remove(request.params.connectionId);
      response.status(204).end();
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "Unable to remove connection." });
    }
  });

  app.post("/api/connections/:connectionId/test", async (request, response) => {
    if (!options.connections) return response.status(503).json({ error: "Connection service is not ready." });
    try {
      response.json(await options.connections.test(request.params.connectionId));
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "Unable to test connection." });
    }
  });

  app.get("/api/roles", async (_request, response) => {
    const roles = readyRoles(options.roles, response);
    if (!roles) return;
    response.json(await roles.list());
  });

  app.post("/api/roles", async (request, response) => {
    const roles = readyRoles(options.roles, response);
    if (!roles) return;
    try {
      response.status(201).json(await roles.create(parseRoleInput(request.body) as CreateRoleInput));
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "Unable to create Role." });
    }
  });

  app.patch("/api/roles/:roleId", async (request, response) => {
    const roles = readyRoles(options.roles, response);
    if (!roles) return;
    try {
      response.json(await roles.update(request.params.roleId, parseRoleInput(request.body) as UpdateRoleInput));
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "Unable to update Role." });
    }
  });

  app.post("/api/roles/:roleId/copy", async (request, response) => {
    const roles = readyRoles(options.roles, response);
    if (!roles) return;
    try {
      response.status(201).json(await roles.copy(request.params.roleId, typeof request.body?.name === "string" ? request.body.name : undefined));
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "Unable to copy Role." });
    }
  });

  app.delete("/api/roles/:roleId", async (request, response) => {
    const roles = readyRoles(options.roles, response);
    if (!roles) return;
    try {
      await roles.remove(request.params.roleId);
      response.status(204).end();
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "Unable to remove Role." });
    }
  });

  app.post("/api/roles/:roleId/verify", async (request, response) => {
    const roles = readyRoles(options.roles, response);
    if (!roles) return;
    try {
      response.json(await roles.verify(request.params.roleId));
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "Unable to verify Role." });
    }
  });

  app.get("/api/backup/export", async (_request, response) => {
    if (!options.backup) return response.status(503).json({ error: "Backup service is not ready." });
    try {
      const exported = await options.backup.exportPackage();
      response.json({
        package: exported.package,
        filename: `personal-ai-workbench-backup-${exported.package.exportedAt.replace(/[:.]/g, "-")}.json`
      });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "Unable to export backup." });
    }
  });

  app.post("/api/backup/import", async (request, response) => {
    if (!options.backup) return response.status(503).json({ error: "Backup service is not ready." });
    try {
      const payload = request.body?.package ?? request.body;
      const result = await options.backup.importPackage(payload);
      response.json(result);
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "Unable to import backup." });
    }
  });

  // Serve installed PWA assets from the same loopback origin so desktop shortcuts auto-connect.
  if (options.webRoot) {
    const webRoot = options.webRoot;
    app.use(express.static(webRoot, { index: "index.html", fallthrough: true }));
    app.get(/^(?!\/api(?:\/|$)).*/, (request, response, next) => {
      if (request.method !== "GET" && request.method !== "HEAD") {
        next();
        return;
      }
      response.sendFile("index.html", { root: webRoot }, (error) => {
        if (error) next();
      });
    });
  }

  // Surface body-parser limit failures with a clear local message (backup import uses a higher cap).
  app.use((error: unknown, _request: Request, response: Response, next: (err?: unknown) => void) => {
    if (!error || typeof error !== "object") {
      next(error);
      return;
    }
    const err = error as { type?: string; status?: number; statusCode?: number; message?: string };
    const status = err.status ?? err.statusCode;
    if (err.type === "entity.too.large" || status === 413) {
      response.status(413).json({
        error: "请求体过大。备份导入上限为 50MB；其他接口仍为 1MB。"
      });
      return;
    }
    next(error);
  });

  return app;
}

function sameCommand(left: unknown[], right: string[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

/** Maps in-progress verify/discard mutual-exclusion failures to HTTP 409. */
function isWorktreeBusyConflict(message: string): boolean {
  return /验证命令正在运行中|验证运行中，无法放弃|正在放弃此 Worktree|正在放弃或已放弃，无法运行验证/.test(message);
}

async function startProfessionalCorrection(
  service: ProfessionalAgentService | undefined,
  runId: string,
  input: { instruction: string; changeKind?: CorrectionChangeKind }
) {
  if (!service) throw new Error("Professional Agent service is not ready.");
  return service.correctAndContinue(runId, input);
}

async function startCodexCorrection(
  service: CodexCliService | undefined,
  runId: string,
  input: { instruction: string; changeKind?: CorrectionChangeKind }
) {
  if (!service) throw new Error("Codex CLI service is not ready.");
  return service.correctAndContinue(runId, input);
}

function toPublicConnection(connection: ModelConnection): Omit<ModelConnection, "credentialRef"> {
  const { credentialRef: _credentialRef, ...publicConnection } = connection;
  return publicConnection;
}

function readyRoles(roles: RoleService | undefined, response: Response): RoleService | undefined {
  if (roles) return roles;
  response.status(503).json({ error: "Role service is not ready." });
  return undefined;
}

function parseRoleInput(body: unknown): Partial<CreateRoleInput> & { enabled?: boolean } {
  const value = (body ?? {}) as Record<string, unknown>;
  const text = (key: string) => typeof value[key] === "string" ? value[key] : undefined;
  const nullableText = (key: string) => value[key] === null ? null : text(key);
  const list = (key: string) => Array.isArray(value[key]) ? value[key].filter((entry): entry is string => typeof entry === "string") : undefined;
  const permissions = parseRolePermissions(value.permissions);
  return {
    roleKind: value.roleKind === "firstmate" ? "firstmate" : value.roleKind === "ordinary" ? "ordinary" : undefined,
    name: text("name"),
    responsibility: text("responsibility"),
    systemInstruction: text("systemInstruction"),
    connectionId: nullableText("connectionId"),
    modelId: nullableText("modelId"),
    harness: value.harness === "api" || value.harness === "codex-cli" ? value.harness : undefined,
    reasoningEffort: value.reasoningEffort === "low" || value.reasoningEffort === "medium" || value.reasoningEffort === "high" ? value.reasoningEffort : undefined,
    skills: list("skills"),
    tools: list("tools"),
    permissions,
    allowFirstmateAutoInvoke: typeof value.allowFirstmateAutoInvoke === "boolean" ? value.allowFirstmateAutoInvoke : undefined,
    enabled: typeof value.enabled === "boolean" ? value.enabled : undefined
  };
}

function parseRolePermissions(value: unknown): AgentRole["permissions"] | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Role permissions are invalid.");
  const permissions = value as Record<string, unknown>;
  if (
    (permissions.workspace !== "project_only" && permissions.workspace !== "read_only")
    || typeof permissions.network !== "boolean"
    || typeof permissions.shell !== "boolean"
    || typeof permissions.externalSend !== "boolean"
  ) throw new Error("Role permissions are invalid.");
  return {
    workspace: permissions.workspace,
    network: permissions.network,
    shell: permissions.shell,
    externalSend: permissions.externalSend
  };
}

function parseQueueConfigUpdate(body: unknown): QueueConfigUpdate {
  const value = (body ?? {}) as Record<string, unknown>;
  const numberField = (key: string): number | undefined => {
    if (value[key] === undefined) return undefined;
    if (typeof value[key] !== "number" || !Number.isFinite(value[key])) {
      throw new Error(`${key} must be a number.`);
    }
    return value[key] as number;
  };
  return {
    maxWriteParallel: numberField("maxWriteParallel"),
    maxReadOnlyParallel: numberField("maxReadOnlyParallel"),
    maxIsolatedSameProjectWriteParallel: numberField("maxIsolatedSameProjectWriteParallel"),
    executionTimeoutMs: numberField("executionTimeoutMs"),
    maxRetries: numberField("maxRetries"),
    minFreeDiskBytes: numberField("minFreeDiskBytes"),
    minFreeMemoryBytes: numberField("minFreeMemoryBytes")
  };
}

function parseProfessionalAgentInput(body: unknown): StartProfessionalAgentInput {
  const value = (body ?? {}) as Record<string, unknown>;
  const roleId = typeof value.roleId === "string" ? value.roleId : undefined;
  if (value.temporaryAgent === undefined) {
    return {
      roleId,
      saveTemporaryRole: typeof value.saveTemporaryRole === "boolean" ? value.saveTemporaryRole : undefined,
      confirmSaveTemporaryRole: typeof value.confirmSaveTemporaryRole === "boolean" ? value.confirmSaveTemporaryRole : undefined
    };
  }
  if (!value.temporaryAgent || typeof value.temporaryAgent !== "object" || Array.isArray(value.temporaryAgent)) {
    throw new Error("Temporary Professional Agent is invalid.");
  }
  const temporary = value.temporaryAgent as Record<string, unknown>;
  const tools = temporary.tools === undefined
    ? undefined
    : Array.isArray(temporary.tools) && temporary.tools.every((tool) => typeof tool === "string")
      ? temporary.tools
      : undefined;
  if (temporary.tools !== undefined && tools === undefined) throw new Error("Temporary Professional Agent tools must be a string array.");
  const temporaryAgent: TemporaryProfessionalAgentInput = {
    name: typeof temporary.name === "string" ? temporary.name : "",
    responsibility: typeof temporary.responsibility === "string" ? temporary.responsibility : "",
    systemInstruction: typeof temporary.systemInstruction === "string" ? temporary.systemInstruction : "",
    connectionId: typeof temporary.connectionId === "string" ? temporary.connectionId : "",
    modelId: typeof temporary.modelId === "string" ? temporary.modelId : undefined,
    tools
  };
  return {
    roleId,
    temporaryAgent,
    saveTemporaryRole: typeof value.saveTemporaryRole === "boolean" ? value.saveTemporaryRole : undefined,
    confirmSaveTemporaryRole: typeof value.confirmSaveTemporaryRole === "boolean" ? value.confirmSaveTemporaryRole : undefined
  };
}

function isCorrectionChangeKind(value: unknown): value is CorrectionChangeKind {
  return value === "minor" || value === "goal" || value === "scope" || value === "acceptance" || value === "prohibition";
}

function parseWorkspaceFingerprint(value: unknown): WorkspaceFingerprint | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    (candidate.kind !== "git_status" && candidate.kind !== "content_hash" && candidate.kind !== "empty")
    || typeof candidate.value !== "string"
    || typeof candidate.capturedAt !== "string"
  ) {
    return undefined;
  }
  return {
    kind: candidate.kind,
    value: candidate.value,
    capturedAt: candidate.capturedAt,
    pathCount: typeof candidate.pathCount === "number" ? candidate.pathCount : 0
  };
}
