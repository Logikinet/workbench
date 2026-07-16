/**
 * todos.dev operation flow (clone of the human loop):
 *
 *   说任务 / 建 Todo
 *     → 自动 Planning（出计划）
 *     → Plan ready · 等人 Confirm
 *     → 确认并构建 → Building（多 Agent / 本机执行）
 *     → Review → Done
 *
 * 人的主操作只有：说话、确认计划、看结果。不手点 Run/角色/Codex。
 */

import { createTodoClient } from "./todos.js";
import {
  createRunClient,
  type PlanOrchestrationResult,
  type RunRecord
} from "./runs.js";
import { createRoleClient } from "./roles.js";
import { createSubtaskClient } from "./subtasks.js";
import { createProjectClient } from "./projects.js";
import {
  createSessionClient,
  type AgentSessionRecord
} from "./sessions.js";
import { deriveTodosPhase, type TodosPhase } from "./todosFlow.js";

function titleFromMessage(content: string): string {
  const line = content.trim().split(/\r?\n/)[0]?.trim() || "新任务";
  return line.length > 48 ? `${line.slice(0, 48)}…` : line;
}

const ACTIVE_RUN = new Set([
  "created",
  "planning",
  "waiting_for_user",
  "awaiting_plan_approval",
  "queued",
  "running",
  "paused",
  "awaiting_review",
  "awaiting_acceptance"
]);

function summarizeOrchestration(orch?: PlanOrchestrationResult): string[] {
  if (!orch) return [];
  const steps: string[] = [];
  if (orch.error) {
    steps.push(`编排失败：${orch.error}`);
    return steps;
  }
  if (orch.dagCreated) steps.push("已拆分子任务");
  if (orch.startedAgents?.length) {
    steps.push(`已启动 ${orch.startedAgents.length} 个 Builder`);
  }
  if (orch.errors?.length) {
    steps.push(orch.errors.slice(0, 2).join("；"));
  }
  return steps;
}

export function createChatBridge(serviceUrl: string) {
  const sessions = createSessionClient(serviceUrl);
  const todos = createTodoClient(serviceUrl);
  const runs = createRunClient(serviceUrl);
  const roles = createRoleClient(serviceUrl);
  const subtasks = createSubtaskClient(serviceUrl);
  const projects = createProjectClient(serviceUrl);

  async function resolveProjectId(preferred?: string): Promise<string | undefined> {
    if (preferred) return preferred;
    try {
      const list = await projects.list();
      return list.find((p) => p.status === "active")?.id;
    } catch {
      return undefined;
    }
  }

  async function preflight(): Promise<{ ok: true } | { ok: false; message: string }> {
    try {
      const [roleList, projectList] = await Promise.all([roles.list(), projects.list()]);
      const activeProject = projectList.find((p) => p.status === "active");
      if (!activeProject) {
        return {
          ok: false,
          message: "还没有工作区。请重启服务或到「项目」创建一个。"
        };
      }
      const apiRole = roleList.find((r) => r.enabled && r.harness === "api" && r.connectionId);
      const codexRole = roleList.find((r) => r.enabled && r.harness === "codex-cli");
      if (!apiRole && !codexRole) {
        const anyApi = roleList.find((r) => r.enabled && r.harness === "api");
        if (anyApi && !anyApi.connectionId) {
          return {
            ok: false,
            message: `角色「${anyApi.name}」未绑定模型。请到「Agents」绑定连接。`
          };
        }
        return {
          ok: false,
          message: "请先配置「模型」API Key，并在「Agents」绑定一个 API 角色。"
        };
      }
      return { ok: true };
    } catch (e) {
      return {
        ok: false,
        message: `服务不可用：${e instanceof Error ? e.message : "未知错误"}（请用 http://127.0.0.1:41731）`
      };
    }
  }

  async function attachProjectIfMissing(todoId: string, preferred?: string): Promise<void> {
    const projectId = await resolveProjectId(preferred);
    if (!projectId) return;
    try {
      const all = await todos.list({});
      const todo = all.find((t) => t.id === todoId);
      if (todo && !todo.projectId) {
        await todos.update(todoId, { projectId });
      }
    } catch {
      /* optional */
    }
  }

  /** Start builders after plan is approved (server orchestration + fallback). */
  async function startBuilders(run: RunRecord): Promise<{ run: RunRecord; steps: string[] }> {
    let current = run;
    const steps: string[] = [];

    if (current.status === "queued" || current.status === "created") {
      try {
        try {
          const dag = await subtasks.getByRunId(current.id);
          const running = dag.subtasks.find(
            (s) => s.status === "running" && s.agentInstance?.roleId
          );
          if (running?.agentInstance?.roleId) {
            const harness = running.agentInstance.harness ?? "api";
            if (harness === "codex-cli") {
              current = await runs.executeCodexCli(current.id, {
                roleId: running.agentInstance.roleId
              });
            } else {
              current = await runs.executeProfessionalAgent(current.id, {
                roleId: running.agentInstance.roleId
              });
            }
            steps.push(`Builder「${running.agentInstance.name}」已开始`);
            return { run: current, steps };
          }
        } catch {
          /* no dag */
        }

        const list = await roles.list();
        const role =
          list.find((r) => r.enabled && r.harness === "api" && r.connectionId) ||
          list.find((r) => r.enabled && r.harness === "codex-cli") ||
          list.find((r) => r.enabled && r.harness === "api");
        if (!role) {
          steps.push("没有可执行的 Agent，请到 Agents 配置");
          return { run: current, steps };
        }
        if (role.harness === "codex-cli") {
          current = await runs.executeCodexCli(current.id, { roleId: role.id });
        } else {
          current = await runs.executeProfessionalAgent(current.id, { roleId: role.id });
        }
        steps.push(`Builder「${role.name}」已开始`);
      } catch (e) {
        steps.push(`构建未启动：${e instanceof Error ? e.message : "失败"}`);
      }
    } else if (current.status === "running") {
      steps.push("构建进行中");
    }

    return { run: current, steps };
  }

  /**
   * todos: Confirm to build
   * = approve plan + start builders (the main human gate after planning)
   */
  async function confirmToBuild(
    runId: string,
    summary = "确认计划，开始构建（todos 流程）"
  ): Promise<{ run: RunRecord; notice: string; phase: TodosPhase }> {
    const ready = await preflight();
    if (!ready.ok) throw new Error(ready.message);

    let run: RunRecord | undefined;
    const steps: string[] = [];

    // Approve plan when still waiting; if already approved/queued, just start builders.
    try {
      const decided = await runs.decidePlanDetailed(runId, {
        decision: "approved",
        summary
      });
      run = decided.run;
      steps.push("计划已确认");
      steps.push(...summarizeOrchestration(decided.orchestration));
      if (decided.orchestration?.startedAgents?.length) {
        return {
          run,
          notice: steps.join(" → "),
          phase: deriveTodosPhase(
            { id: "", title: "", status: "running", archived: false },
            run
          )
        };
      }
    } catch {
      // Already decided or not awaiting — continue to start builders if possible
    }

    if (!run) {
      // decidePlan failed: try list via subtasks error path — use professional execute directly
      // by re-fetching is hard without getRun; startBuilders needs a run object.
      // Fallback: empty start with only id fields we can recover from execute response.
      try {
        const list = await roles.list();
        const role =
          list.find((r) => r.enabled && r.harness === "api" && r.connectionId) ||
          list.find((r) => r.enabled);
        if (!role) throw new Error("没有可执行的 Agent");
        run =
          role.harness === "codex-cli"
            ? await runs.executeCodexCli(runId, { roleId: role.id })
            : await runs.executeProfessionalAgent(runId, { roleId: role.id });
        steps.push(`Builder「${role.name}」已开始`);
        return {
          run,
          notice: steps.join(" → ") || "已开始构建",
          phase: deriveTodosPhase(
            { id: "", title: "", status: "running", archived: false },
            run
          )
        };
      } catch (e) {
        throw new Error(e instanceof Error ? e.message : "无法确认并构建");
      }
    }

    const started = await startBuilders(run);
    run = started.run;
    steps.push(...started.steps);

    return {
      run,
      notice: steps.join(" → ") || "已确认并开始构建",
      phase: deriveTodosPhase({ id: "", title: "", status: "running", archived: false }, run)
    };
  }

  /**
   * todos: create Todo + run planning only (stop at Plan ready / confirm).
   * Does NOT auto-build — user confirms like todos.dev.
   */
  async function startPlanning(
    todoId: string,
    message: string
  ): Promise<{ run: RunRecord; notice: string; phase: TodosPhase }> {
    const ready = await preflight();
    if (!ready.ok) throw new Error(ready.message);
    await attachProjectIfMissing(todoId);

    const text = message.trim() || "请规划此任务并给出可执行计划。";
    const history = await runs.list(todoId);
    const active = history.find((r) => ACTIVE_RUN.has(r.status));

    let run: RunRecord;
    if (active) {
      // Already has active run — if plan ready, tell user to confirm
      const phase = deriveTodosPhase(
        { id: todoId, title: "", status: "awaiting_confirmation", archived: false },
        active
      );
      if (phase === "confirm") {
        return {
          run: active,
          notice: "Plan ready — 请确认并构建",
          phase: "confirm"
        };
      }
      if (phase === "building" || phase === "review") {
        return { run: active, notice: `进行中（${phase}）`, phase };
      }
      run = await runs.addMessage(active.id, text);
    } else {
      run = await runs.create(todoId, text);
    }

    // If still waiting for critical input, push context once
    if (
      run.status === "waiting_for_user" ||
      run.planning?.approvalStatus === "awaiting_input"
    ) {
      try {
        run = await runs.updatePlanning(run.id, { additionalContext: text });
      } catch {
        /* keep */
      }
    }

    const phase = deriveTodosPhase(
      { id: todoId, title: "", status: "awaiting_confirmation", archived: false },
      run
    );

    if (phase === "confirm") {
      return {
        run,
        notice: "Planning 完成 · Plan ready · 请确认并构建",
        phase: "confirm"
      };
    }
    if (phase === "blocked") {
      return { run, notice: "规划需要你补充信息", phase: "blocked" };
    }
    return {
      run,
      notice: `已进入 ${phase}`,
      phase
    };
  }

  /**
   * Chief message → ensure Todo + Planning (todos default: stop for confirm).
   * Pass confirmBuild: true only when user wants one-shot (not pure todos).
   */
  async function sendAndDispatch(
    session: AgentSessionRecord,
    content: string,
    options: {
      projectId?: string;
      preferredModelId?: string;
      /** When true, also confirm plan and build (one-shot). Default false = todos confirm gate. */
      confirmBuild?: boolean;
    } = {}
  ): Promise<{
    session: AgentSessionRecord;
    run?: RunRecord;
    notice: string;
    phase?: TodosPhase;
    needsConfirm?: boolean;
  }> {
    const text = content.trim();
    if (!text) throw new Error("消息不能为空。");

    const ready = await preflight();
    if (!ready.ok) throw new Error(ready.message);

    let current = await sessions.appendMessage(session.id, text, "force");

    let todoId = current.todoId;
    if (!todoId) {
      const projectId = await resolveProjectId(options.projectId || current.projectId);
      const todo = await todos.create({
        title: titleFromMessage(text),
        description: text,
        projectId
      });
      todoId = todo.id;
      current = await sessions.update(current.id, {
        todoId,
        title: current.title === "新会话" || !current.title ? titleFromMessage(text) : current.title,
        projectId: projectId || current.projectId
      });
    } else {
      await attachProjectIfMissing(todoId, options.projectId || current.projectId);
    }

    const planned = await startPlanning(todoId, text);
    let run = planned.run;
    current = await sessions.update(current.id, { runId: run.id });

    const steps = [planned.notice];

    // todos default: stop at confirm unless explicitly one-shot
    if (options.confirmBuild && planned.phase === "confirm") {
      const built = await confirmToBuild(run.id);
      run = built.run;
      steps.push(built.notice);
    }

    try {
      current = await sessions.ingestEvents(current.id, [
        {
          kind: "text_delta",
          text: `〔Todos〕${steps.join(" → ")}`
        }
      ]);
    } catch {
      /* optional */
    }

    if (options.preferredModelId && options.preferredModelId !== current.preferredModelId) {
      current = await sessions.update(current.id, {
        preferredModelId: options.preferredModelId
      });
    }

    const phase = planned.phase;
    return {
      session: current,
      run,
      notice: steps.join(" → "),
      phase: options.confirmBuild ? deriveTodosPhase(
        { id: todoId, title: "", status: "running", archived: false },
        run
      ) : phase,
      needsConfirm: !options.confirmBuild && phase === "confirm"
    };
  }

  /** Board: start planning for a todo (or replan). */
  async function startTodoPlan(todoId: string, message?: string) {
    return startPlanning(todoId, message || "请规划此任务并给出可执行计划。");
  }

  /**
   * Board one-shot used to be startTodoGo — now maps to plan then optional confirm.
   * For true todos board button "确认并构建", call confirmToBuild.
   * "开始规划" calls startTodoPlan.
   */
  async function startTodoGo(todoId: string, message: string) {
    const planned = await startPlanning(todoId, message);
    if (planned.phase === "confirm") {
      // Board "开始执行" in old UI meant full go — keep one-shot for that button via confirm
      return confirmToBuild(planned.run.id, "确认计划并开始构建");
    }
    return {
      run: planned.run,
      notice: planned.notice,
      phase: planned.phase
    };
  }

  /** Confirm many plan-ready runs (Chief "Run N"). */
  async function confirmMany(
    runIds: string[]
  ): Promise<{ ok: number; fail: number; notices: string[] }> {
    let ok = 0;
    let fail = 0;
    const notices: string[] = [];
    for (const id of runIds) {
      try {
        const r = await confirmToBuild(id);
        ok += 1;
        notices.push(r.notice);
      } catch (e) {
        fail += 1;
        notices.push(e instanceof Error ? e.message : "失败");
      }
    }
    return { ok, fail, notices };
  }

  return {
    sessions,
    todos,
    runs,
    roles,
    subtasks,
    preflight,
    sendAndDispatch,
    startPlanning,
    startTodoPlan,
    startTodoGo,
    confirmToBuild,
    confirmMany,
    startBuilders
  };
}

export function statusZh(status: string): string {
  const map: Record<string, string> = {
    created: "已创建",
    planning: "规划中",
    waiting_for_user: "等待用户",
    awaiting_plan_approval: "待确认计划",
    queued: "排队构建",
    running: "构建中",
    paused: "已暂停",
    awaiting_review: "待审查",
    awaiting_acceptance: "待验收",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
    interrupted: "已中断",
    idle: "空闲",
    streaming: "输出中"
  };
  return map[status] ?? status;
}
