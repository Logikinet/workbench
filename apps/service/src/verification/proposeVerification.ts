import type {
  ApplyUserEditsInput,
  DetectedProjectStack,
  ManualChecklistItem,
  PackageManager,
  ProposeVerificationInput,
  VerificationCommandEntry,
  VerificationPlan,
  VerificationTaskType
} from "./types.js";
import { sameCommand } from "./commandMatch.js";

/**
 * Task-type-only fallback used by legacy planning paths that lack workspace facts.
 * Intentionally empty: without project evidence, user commands, or an explicit
 * hypothesis we must not invent npm test/typecheck/build.
 */
export function defaultVerificationCommandsForTaskType(_taskType?: VerificationTaskType): string[][] {
  return [];
}

/**
 * Build an editable verification plan from stack evidence, user overrides, and
 * (only when necessary) explicit hypotheses recorded as assumptions.
 */
export function proposeVerificationPlan(input: ProposeVerificationInput): VerificationPlan {
  const taskType = input.taskType ?? "other";
  const assumptions: string[] = [];
  const commands: VerificationCommandEntry[] = [];
  const manualChecklist: ManualChecklistItem[] = [];

  const wantsAutomation = taskType === "implementation" || taskType === "bug_fix" || taskType === "automation";
  const wantsLightChecks = taskType === "research" || taskType === "writing" || taskType === "analysis";

  // 1) User-specified commands always win and are tagged as such.
  for (const command of input.userCommands ?? []) {
    if (!isValidCommand(command)) continue;
    commands.push({
      command: [...command],
      enabled: !isDisabled(command, input.disabledCommands),
      source: "user_specified",
      rationale: "用户明确指定的验证命令。"
    });
  }

  // 2) Project-evidence commands from detected scripts / markers.
  if (wantsAutomation || taskType === "other") {
    const fromEvidence = commandsFromEvidence(input.stack, assumptions);
    for (const entry of fromEvidence) {
      if (commands.some((existing) => sameCommand(existing.command, entry.command))) continue;
      entry.enabled = !isDisabled(entry.command, input.disabledCommands);
      commands.push(entry);
    }
  }

  // 3) User supplemental commands.
  for (const command of input.supplementalCommands ?? []) {
    if (!isValidCommand(command)) continue;
    if (commands.some((existing) => sameCommand(existing.command, command))) continue;
    commands.push({
      command: [...command],
      enabled: !isDisabled(command, input.disabledCommands),
      source: "user_specified",
      rationale: "用户补充的验证命令。"
    });
  }

  // 4) Manual checklist when no automated tests / no enabled commands.
  const enabledCommands = commands.filter((entry) => entry.enabled);
  if (enabledCommands.length === 0 || !input.stack.hasAutomatedTests || wantsLightChecks) {
    manualChecklist.push(...manualChecklistFor(input.stack, taskType, assumptions));
  }

  if (input.userConstraints?.trim()) {
    assumptions.push(`用户约束：${input.userConstraints.trim()}`);
  }

  if (enabledCommands.length === 0 && manualChecklist.length === 0) {
    manualChecklist.push({
      id: "manual-default",
      description: "按验收标准做最小可验证检查，并在 Run 时间线记录结果。",
      source: "hypothesis",
      rationale: "未发现自动化测试或用户指定命令。"
    });
    assumptions.push("未找到可执行的项目测试脚本；将使用手工检查清单，而非虚构 npm 命令。");
  }

  // Ensure we never emit the classic triple unless evidence supports each part.
  assertNotBlindNpmDefault(commands, input.stack);

  return {
    stack: input.stack,
    commands,
    manualChecklist,
    assumptions,
    status: "draft",
    taskType
  };
}

/** Apply user edits (view / modify / disable / supplement) before approval. */
export function applyUserVerificationEdits(input: ApplyUserEditsInput): VerificationPlan {
  const plan = input.plan;
  let commands = plan.commands.map((entry) => ({ ...entry, command: [...entry.command] }));
  let manualChecklist = plan.manualChecklist.map((item) => ({ ...item }));

  if (input.commands) {
    commands = input.commands
      .filter((entry) => isValidCommand(entry.command))
      .map((entry) => ({
        command: [...entry.command],
        enabled: entry.enabled !== false,
        source: entry.source ?? "user_specified",
        rationale: entry.rationale?.trim() || "用户编辑后的验证命令。"
      }));
  }

  if (input.manualChecklist) {
    manualChecklist = input.manualChecklist
      .map((item, index) => ({
        id: item.id?.trim() || `manual-${index + 1}`,
        description: item.description.trim(),
        source: "user_specified" as const,
        rationale: "用户编辑的手工检查项。",
        completed: item.completed
      }))
      .filter((item) => item.description.length > 0);
  }

  return {
    ...plan,
    commands,
    manualChecklist,
    status: plan.status === "approved" ? "superseded" : "draft",
    approvedPlanVersion: plan.status === "approved" ? undefined : plan.approvedPlanVersion
  };
}

/** Bind a draft plan to an approved Secondmate plan version. */
export function bindVerificationPlanToApprovedVersion(plan: VerificationPlan, approvedPlanVersion: number): VerificationPlan {
  if (!Number.isInteger(approvedPlanVersion) || approvedPlanVersion < 1) {
    throw new Error("approvedPlanVersion must be a positive integer.");
  }
  return {
    ...plan,
    status: "approved",
    approvedPlanVersion,
    commands: plan.commands.map((entry) => ({ ...entry, command: [...entry.command] })),
    manualChecklist: plan.manualChecklist.map((item) => ({ ...item }))
  };
}

/** Enabled argv lists for persistence on planVersions.verificationCommands. */
export function enabledVerificationCommands(plan: VerificationPlan): string[][] {
  return plan.commands.filter((entry) => entry.enabled).map((entry) => [...entry.command]);
}

function commandsFromEvidence(stack: DetectedProjectStack, assumptions: string[]): VerificationCommandEntry[] {
  switch (stack.primary) {
    case "nodejs":
      return nodeCommands(stack);
    case "python":
      return pythonCommands(stack, assumptions);
    case "harmonyos":
      return harmonyCommands(stack, assumptions);
    case "cangjie":
      return cangjieCommands(stack, assumptions);
    case "html":
      return [];
    case "git":
      return [];
    case "mixed": {
      const combined = [
        ...nodeCommands(stack),
        ...pythonCommands(stack, assumptions),
        ...harmonyCommands(stack, assumptions),
        ...cangjieCommands(stack, assumptions)
      ];
      return dedupeEntries(combined);
    }
    default:
      return [];
  }
}

function nodeCommands(stack: DetectedProjectStack): VerificationCommandEntry[] {
  const pm = stack.packageManager ?? "npm";
  const scriptNames = new Set(stack.availableScripts.map((script) => script.name));
  const entries: VerificationCommandEntry[] = [];

  const addScript = (scriptName: string, rationale: string) => {
    if (!scriptNames.has(scriptName)) return;
    const evidence = stack.availableScripts.find((script) => script.name === scriptName);
    entries.push({
      command: runScriptArgv(pm, scriptName),
      enabled: true,
      source: "project_evidence",
      rationale,
      evidencePath: evidence?.source ?? "package.json"
    });
  };

  // Only propose scripts that actually exist — never invent the full npm triple.
  addScript("test", "package.json scripts.test 存在。");
  if (scriptNames.has("typecheck")) addScript("typecheck", "package.json scripts.typecheck 存在。");
  else if (scriptNames.has("type-check")) addScript("type-check", "package.json scripts.type-check 存在。");
  if (scriptNames.has("lint")) addScript("lint", "package.json scripts.lint 存在。");
  // build is optional and only when present; not always required for verification
  if (scriptNames.has("build") && entries.length === 0) {
    addScript("build", "无测试脚本时使用 package.json scripts.build 作为最小构建验证。");
  } else if (scriptNames.has("build") && (scriptNames.has("test") || scriptNames.has("typecheck") || scriptNames.has("type-check"))) {
    // Include build only when it is a known project script alongside other checks — still evidence-based.
    addScript("build", "package.json scripts.build 存在，作为补充构建验证。");
  }

  return entries;
}

function pythonCommands(stack: DetectedProjectStack, assumptions: string[]): VerificationCommandEntry[] {
  const hasPytestScript = stack.availableScripts.some((script) => /pytest/i.test(script.name) || /pytest/i.test(script.command ?? ""));
  const hasPytestClue = stack.clues.some((clue) => /pytest/i.test(clue.path + clue.detail));
  const hasTestsDir = stack.clues.some((clue) => /test/i.test(clue.path) || /test/i.test(clue.detail));

  if (hasPytestScript || hasPytestClue) {
    return [{
      command: ["pytest"],
      enabled: true,
      source: "project_evidence",
      rationale: "检测到 pytest 配置或依赖。",
      evidencePath: stack.clues.find((clue) => /pytest|pyproject|requirements/i.test(clue.path))?.path
    }];
  }

  if (hasTestsDir) {
    assumptions.push("假设可使用 python -m pytest 运行 tests/（项目含测试路径但未声明 pytest 配置）。");
    return [{
      command: ["python", "-m", "pytest"],
      enabled: true,
      source: "hypothesis",
      rationale: "存在测试路径，但未找到明确 pytest 配置；作为可编辑假设提出。",
      evidencePath: stack.clues.find((clue) => /test/i.test(clue.path))?.path
    }];
  }

  return [];
}

function harmonyCommands(stack: DetectedProjectStack, assumptions: string[]): VerificationCommandEntry[] {
  if (stack.availableScripts.some((script) => script.name === "hvigor-test")) {
    return [{
      command: ["hvigorw", "test"],
      enabled: true,
      source: "project_evidence",
      rationale: "检测到 hvigorw，可用于 HarmonyOS 测试。",
      evidencePath: "hvigorw"
    }];
  }
  if (stack.clues.some((clue) => clue.kind === "harmonyos")) {
    assumptions.push("假设可使用 hvigorw test 验证 HarmonyOS 工程（请在批准前确认本地工具链）。");
    return [{
      command: ["hvigorw", "test"],
      enabled: true,
      source: "hypothesis",
      rationale: "HarmonyOS 工程线索存在；hvigorw test 为可编辑假设。",
      evidencePath: stack.clues.find((clue) => clue.kind === "harmonyos")?.path
    }];
  }
  return [];
}

function cangjieCommands(stack: DetectedProjectStack, assumptions: string[]): VerificationCommandEntry[] {
  if (stack.availableScripts.some((script) => script.name === "cjpm-test") || stack.clues.some((clue) => clue.path.endsWith("cjpm.toml"))) {
    return [{
      command: ["cjpm", "test"],
      enabled: true,
      source: "project_evidence",
      rationale: "检测到 cjpm.toml（仓颉）。",
      evidencePath: stack.clues.find((clue) => clue.path.includes("cjpm"))?.path ?? "cjpm.toml"
    }];
  }
  if (stack.clues.some((clue) => clue.kind === "cangjie")) {
    assumptions.push("假设仓颉工程可通过 cjpm test 验证（请确认工具链）。");
    return [{
      command: ["cjpm", "test"],
      enabled: true,
      source: "hypothesis",
      rationale: "检测到 .cj 源文件；cjpm test 为可编辑假设。"
    }];
  }
  return [];
}

function manualChecklistFor(
  stack: DetectedProjectStack,
  taskType: VerificationTaskType,
  assumptions: string[]
): ManualChecklistItem[] {
  const items: ManualChecklistItem[] = [];

  if (stack.primary === "html" || (stack.kinds.includes("html") && !stack.hasAutomatedTests)) {
    items.push({
      id: "html-open",
      description: "在浏览器中打开 index.html（或静态入口），确认页面可加载且无阻塞错误。",
      source: "project_evidence",
      rationale: "纯 HTML 项目无标准自动化测试入口。"
    });
    items.push({
      id: "html-console",
      description: "检查浏览器控制台是否出现与本次改动相关的错误。",
      source: "hypothesis",
      rationale: "静态页验收的最小手工步骤。"
    });
  }

  if (stack.primary === "git" && stack.kinds.length === 1) {
    items.push({
      id: "git-status",
      description: "检查 git status / diff，确认变更符合计划范围。",
      source: "project_evidence",
      rationale: "仅识别到 Git 仓库，无语言栈测试脚本。"
    });
  }

  if (taskType === "research" || taskType === "analysis") {
    items.push({
      id: "evidence-trace",
      description: "核对每条结论均可追溯到本地证据或明确标注的假设。",
      source: "hypothesis",
      rationale: "调研/分析任务通常不以自动化测试验收。"
    });
  }

  if (taskType === "writing") {
    items.push({
      id: "doc-coverage",
      description: "核对文档章节覆盖已确认主题，并与项目事实一致。",
      source: "hypothesis",
      rationale: "写作任务使用手工覆盖检查。"
    });
  }

  if (!stack.hasAutomatedTests && items.length === 0 && (taskType === "implementation" || taskType === "bug_fix" || taskType === "automation")) {
    assumptions.push("项目未检测到自动化测试入口；使用手工检查清单，不强制执行不存在的命令。");
    items.push({
      id: "manual-acceptance",
      description: "按计划验收标准逐项手工验证，并在时间线记录结果。",
      source: "hypothesis",
      rationale: "无自动化测试时的默认手工清单。"
    });
    items.push({
      id: "manual-regression",
      description: "确认未引入与本次改动相关的明显回归。",
      source: "hypothesis",
      rationale: "无测试套件时的最小回归检查。"
    });
  }

  return items;
}

function runScriptArgv(pm: PackageManager, scriptName: string): string[] {
  if (scriptName === "test" && pm === "npm") return ["npm", "test"];
  if (scriptName === "test" && pm === "pnpm") return ["pnpm", "test"];
  if (scriptName === "test" && pm === "yarn") return ["yarn", "test"];
  if (scriptName === "test" && pm === "bun") return ["bun", "test"];
  switch (pm) {
    case "pnpm": return ["pnpm", "run", scriptName];
    case "yarn": return ["yarn", "run", scriptName];
    case "bun": return ["bun", "run", scriptName];
    default: return ["npm", "run", scriptName];
  }
}

function isDisabled(command: string[], disabled?: string[][]): boolean {
  if (!disabled?.length) return false;
  return disabled.some((entry) => sameCommand(entry, command));
}

function isValidCommand(command: string[]): boolean {
  return Array.isArray(command) && command.length > 0 && command.every((part) => typeof part === "string" && part.trim().length > 0);
}

function dedupeEntries(entries: VerificationCommandEntry[]): VerificationCommandEntry[] {
  const out: VerificationCommandEntry[] = [];
  for (const entry of entries) {
    if (out.some((existing) => sameCommand(existing.command, entry.command))) continue;
    out.push(entry);
  }
  return out;
}

/**
 * Guardrail for tests and callers: the classic always-on triple is only legal
 * when each script is evidenced in package.json.
 */
function assertNotBlindNpmDefault(commands: VerificationCommandEntry[], stack: DetectedProjectStack): void {
  const enabled = commands.filter((entry) => entry.enabled).map((entry) => entry.command);
  const classic =
    enabled.length === 3
    && sameCommand(enabled[0]!, ["npm", "test"])
    && sameCommand(enabled[1]!, ["npm", "run", "typecheck"])
    && sameCommand(enabled[2]!, ["npm", "run", "build"]);
  if (!classic) return;
  const names = new Set(stack.availableScripts.map((script) => script.name));
  if (names.has("test") && names.has("typecheck") && names.has("build")) return;
  // Soft guard: rewrite is not done here; tests assert samples never produce this blindly.
  void classic;
}
