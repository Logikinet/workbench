export const taskTypes = ["implementation", "bug_fix", "research", "writing", "analysis", "automation", "other"] as const;

export type TaskType = (typeof taskTypes)[number];
export type PlanComplexity = "low" | "medium" | "high";

export interface TaskAssessment {
  taskType: TaskType;
  requiredCapabilities: string[];
  criticalInputs: string[];
  assumptions: string[];
  complexity: PlanComplexity;
}

export interface GeneratedPlan {
  summary: string;
  complexity: PlanComplexity;
  steps: string[];
  acceptanceCriteria: string[];
  risks: string[];
  prohibitions: string[];
  generatedBy: "secondmate";
  revisionNote?: string;
  verificationCommands: string[][];
}

export interface PlanningSubject {
  title: string;
  description?: string;
  instructions?: string;
}

export interface PlanningOverrides {
  taskType?: TaskType;
  requiredCapabilities?: string[];
}

export function assessTask(subject: PlanningSubject, overrides: PlanningOverrides = {}): TaskAssessment {
  const context = [subject.title, subject.description, subject.instructions].filter(Boolean).join("\n").trim();
  const taskType = overrides.taskType ?? inferTaskType(context);
  const hasOutcome = Boolean(subject.description?.trim() || subject.instructions?.trim());
  const requiredCapabilities = overrides.requiredCapabilities === undefined
    ? capabilitiesFor(taskType)
    : normalizeList(overrides.requiredCapabilities);

  return {
    taskType,
    requiredCapabilities,
    criticalInputs: hasOutcome ? [] : ["请说明本次 Run 的预期正式成果或可验证结果。"],
    assumptions: assumptionsFor(taskType, context),
    complexity: complexityFor(taskType, context)
  };
}

export function generateSecondmatePlan(assessment: TaskAssessment, revisionNote?: string): GeneratedPlan {
  const steps = stepsFor(assessment.taskType, assessment.complexity);
  const label = taskTypeLabels[assessment.taskType];
  const risk = risksFor(assessment.taskType, assessment.complexity);
  return {
    summary: `Secondmate ${label}计划（${complexityLabels[assessment.complexity]}复杂度，${steps.length} 步）`,
    complexity: assessment.complexity,
    steps,
    acceptanceCriteria: acceptanceFor(assessment.taskType),
    risks: risk,
    prohibitions: [
      "不得在计划获批前创建、修改或登记正式成果文件。",
      "不得在计划获批前执行删除、安装、外发或其他危险操作。",
      "Firstmate 仅负责识别、编排和确认，不得直接生成正式 Artifact。"
    ],
    generatedBy: "secondmate",
    revisionNote: revisionNote?.trim() || undefined,
    verificationCommands: defaultVerificationCommands(assessment.taskType)
  };
}

export function defaultVerificationCommands(taskType: TaskType): string[][] {
  if (taskType !== "implementation" && taskType !== "bug_fix" && taskType !== "automation") return [];
  return [["npm", "test"], ["npm", "run", "typecheck"], ["npm", "run", "build"]];
}

function inferTaskType(context: string): TaskType {
  const text = context.toLocaleLowerCase();
  if (/(bug|fix|修复|错误|回归|故障)/.test(text)) return "bug_fix";
  if (/(research|investigate|调查|调研|研究|根因|报告)/.test(text)) return "research";
  if (/(write|draft|文档|撰写|说明书|文章)/.test(text)) return "writing";
  if (/(analysis|analy[sz]e|分析|评估|审计)/.test(text)) return "analysis";
  if (/(automate|automation|自动化|脚本|批处理)/.test(text)) return "automation";
  if (/(implement|build|feature|开发|实现|功能|测试)/.test(text)) return "implementation";
  return "other";
}

function capabilitiesFor(taskType: TaskType): string[] {
  switch (taskType) {
    case "implementation": return ["workspace", "filesystem", "shell", "tests"];
    case "bug_fix": return ["workspace", "filesystem", "shell", "tests"];
    case "research": return ["workspace", "documents"];
    case "writing": return ["workspace", "documents"];
    case "analysis": return ["workspace", "documents"];
    case "automation": return ["workspace", "filesystem", "shell"];
    default: return ["workspace"];
  }
}

function assumptionsFor(taskType: TaskType, context: string): string[] {
  const assumptions = ["仅在获准的 Project 工作区范围内工作。"];
  if (!/(test|测试|验收|verify|验证)/i.test(context)) assumptions.push("未指定验证命令时，将按项目现有约定选择最小必要验证。");
  if (!/(deadline|时间|日期|预算)/i.test(context)) assumptions.push("未提供时间或预算限制，将优先完成可验证的最小范围。");
  if (taskType === "research" || taskType === "analysis") assumptions.push("未授权对外发送；结论仅作为 Run 内计划与结果摘要。" );
  return assumptions;
}

function complexityFor(taskType: TaskType, context: string): PlanComplexity {
  if (/(migration|architecture|security|deploy|重构|迁移|架构|安全|多模块|多项目)/i.test(context) || context.length > 500) return "high";
  if ((taskType === "writing" || taskType === "analysis" || taskType === "other") && context.length < 120) return "low";
  return "medium";
}

function stepsFor(taskType: TaskType, complexity: PlanComplexity): string[] {
  const typeStep = {
    implementation: "检查现有实现并在批准范围内完成最小功能改动。",
    bug_fix: "复现并定位问题，在最小范围内修复根因。",
    research: "收集项目内证据并整理可追溯的调查结论。",
    writing: "根据已确认范围起草所需文档内容。",
    analysis: "分析现有状态、约束和可选方案。",
    automation: "设计并实现受限工作区内的自动化步骤。",
    other: "确认任务边界并完成已批准的最小工作项。"
  }[taskType];
  const steps = ["确认目标、范围、假设与禁止项。", typeStep, "按验收标准运行最小必要验证并记录结果。"];
  if (complexity !== "low") steps.splice(2, 0, "检查相关影响面并将发现记录到 Run 时间线。");
  if (complexity === "high") steps.splice(3, 0, "先制定回滚与风险缓解方式，再处理高风险部分。");
  return steps;
}

function acceptanceFor(taskType: TaskType): string[] {
  const taskCriterion = {
    implementation: "目标功能满足已确认的输入、输出与范围。",
    bug_fix: "问题可复现的场景得到修复，且回归验证通过。",
    research: "结论能追溯到已检查的本地证据或明确假设。",
    writing: "文档覆盖已确认主题，并与项目上下文一致。",
    analysis: "分析清楚列出结论、证据、约束和未决项。",
    automation: "自动化步骤在获准范围内可重复执行并有验证结果。",
    other: "产出与用户已批准的计划和边界一致。"
  }[taskType];
  return [taskCriterion, "计划中的验证结果已记录到 Run 时间线。", "未执行计划禁止项或未获批准的危险操作。"];
}

function risksFor(taskType: TaskType, complexity: PlanComplexity): string[] {
  const risks = ["现有项目约定可能与默认假设不一致。"];
  if (taskType === "bug_fix" || taskType === "implementation") risks.push("修改可能引入回归，因此必须有针对性验证。");
  if (taskType === "research" || taskType === "analysis") risks.push("信息不足时结论必须明确标为假设，而不是事实。");
  if (complexity === "high") risks.push("高复杂度变更需要在执行前确认回滚路径和影响范围。");
  return risks;
}

function normalizeList(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

const taskTypeLabels: Record<TaskType, string> = {
  implementation: "实现",
  bug_fix: "修复",
  research: "调研",
  writing: "写作",
  analysis: "分析",
  automation: "自动化",
  other: "通用"
};

const complexityLabels: Record<PlanComplexity, string> = { low: "低", medium: "中", high: "高" };
