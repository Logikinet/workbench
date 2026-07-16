/**
 * Hash routes aligned with real todos.dev app (from HTML dumps):
 * /chief, /inbox, /app, /projects, /resources/providers|skills|secrets, /agents
 * Optional panel=todo:{id} → right-side todo drawer
 */

export const workbenchSections = [
  "home", // /chief 总管
  "waiting", // /inbox
  "todos", // board (project todos list)
  "projects",
  "connections", // /resources/providers 模型
  "skills", // /resources/skills
  "secrets", // /resources/secrets 密钥 (mapped to settings/backup-lite placeholder uses connections for now)
  "mcp",
  "triggers",
  "documents",
  "agents",
  "team", // /app 团队
  "settings"
] as const;

export type WorkbenchSection = (typeof workbenchSections)[number];

export interface WorkbenchRoute {
  section: WorkbenchSection;
  /** Deep-link / right panel Todo id (todos panel=todo:xxx) */
  todoId?: string;
  projectId?: string;
}

/** 侧栏中文 — 对齐桌面 todos html 快照 */
export const sectionLabels: Record<WorkbenchSection, string> = {
  home: "总管",
  waiting: "收件箱",
  todos: "Todos",
  projects: "项目",
  connections: "模型",
  skills: "技能",
  secrets: "密钥",
  mcp: "MCP",
  triggers: "触发器",
  documents: "文档",
  agents: "Agents",
  team: "团队",
  settings: "设置"
};

export const routeMeta: Record<
  WorkbenchSection,
  { kicker: string; title: string; description: string }
> = {
  home: {
    kicker: "Chief",
    title: "总管",
    description: "对话建 Todo → Planning → 你确认后 Build"
  },
  waiting: {
    kicker: "Inbox",
    title: "收件箱",
    description: "Plan ready · 确认并构建"
  },
  todos: {
    kicker: "Board",
    title: "Todos",
    description: "Task › Plan › Build"
  },
  projects: {
    kicker: "Projects",
    title: "项目",
    description: "项目与本机工作区"
  },
  connections: {
    kicker: "资源",
    title: "模型",
    description: "Provider 与 API Key"
  },
  skills: {
    kicker: "资源",
    title: "技能",
    description: "Skills 库"
  },
  secrets: {
    kicker: "资源",
    title: "密钥",
    description: "密钥与凭据"
  },
  mcp: {
    kicker: "资源",
    title: "MCP",
    description: "MCP 连接"
  },
  triggers: {
    kicker: "资源",
    title: "触发器",
    description: "本地自动化"
  },
  documents: {
    kicker: "资源",
    title: "文档",
    description: "文档产物"
  },
  agents: {
    kicker: "Team",
    title: "Agents",
    description: "Builder 角色与模型绑定"
  },
  team: {
    kicker: "Team",
    title: "团队",
    description: "成员 · 机器 · 项目"
  },
  settings: {
    kicker: "System",
    title: "设置",
    description: "备份与安装"
  }
};

export function parseWorkbenchHash(hash: string): WorkbenchRoute {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const [pathPart, queryPart] = raw.split("?");
  const path = (pathPart || "").replace(/^\/+/, "").replace(/\/+$/, "");
  const params = new URLSearchParams(queryPart || "");

  // panel=todo:ID or panel=todo%3AID
  let panelTodo: string | undefined;
  const panel = params.get("panel") || "";
  const panelMatch = panel.match(/^todo[:：](.+)$/i);
  if (panelMatch) panelTodo = decodeURIComponent(panelMatch[1].split(":")[0] || "");

  if (!path || path === "home" || path === "chief" || path === "app" && !params.toString()) {
    // bare /app is team in todos; bare home -> chief
    if (path === "app") return { section: "team", todoId: panelTodo };
    return { section: "home", todoId: panelTodo };
  }

  const parts = path.split("/").filter(Boolean);
  const head = (parts[0] ?? "home").toLowerCase();
  const sub = (parts[1] ?? "").toLowerCase();

  if (head === "chief") return { section: "home", todoId: panelTodo };
  if (head === "inbox" || head === "waiting" || head === "waiting-on-me") {
    return { section: "waiting", todoId: panelTodo };
  }
  if (head === "todos") {
    const todoId = parts[1] ? decodeURIComponent(parts[1]) : panelTodo;
    return todoId ? { section: "todos", todoId } : { section: "todos" };
  }
  if (head === "projects") {
    const projectId = parts[1] ? decodeURIComponent(parts[1]) : undefined;
    return { section: "projects", projectId, todoId: panelTodo };
  }
  if (head === "agents" || head === "agent") return { section: "agents", todoId: panelTodo };
  if (head === "team" || head === "teams" || head === "app") {
    return { section: "team", todoId: panelTodo };
  }
  if (head === "resources") {
    if (sub === "providers" || sub === "connections" || sub === "models" || !sub) {
      return { section: "connections", todoId: panelTodo };
    }
    if (sub === "skills") return { section: "skills", todoId: panelTodo };
    if (sub === "secrets") return { section: "secrets", todoId: panelTodo };
    if (sub === "mcp") return { section: "mcp", todoId: panelTodo };
    if (sub === "triggers") return { section: "triggers", todoId: panelTodo };
    if (sub === "documents" || sub === "papers") return { section: "documents", todoId: panelTodo };
    return { section: "connections", todoId: panelTodo };
  }
  if (head === "providers" || head === "connections") {
    return { section: "connections", todoId: panelTodo };
  }
  if (head === "skills") return { section: "skills", todoId: panelTodo };
  if (head === "secrets") return { section: "secrets", todoId: panelTodo };
  if (head === "mcp") return { section: "mcp", todoId: panelTodo };
  if (head === "triggers") return { section: "triggers", todoId: panelTodo };
  if (head === "documents" || head === "document-workflow" || head === "papers") {
    return { section: "documents", todoId: panelTodo };
  }
  if (head === "settings" || head === "install" || head === "api-keys") {
    return { section: "settings", todoId: panelTodo };
  }
  if ((workbenchSections as readonly string[]).includes(head)) {
    return { section: head as WorkbenchSection, todoId: panelTodo };
  }
  return { section: "home", todoId: panelTodo };
}

export function formatWorkbenchHash(route: WorkbenchRoute): string {
  let base: string;
  switch (route.section) {
    case "home":
      base = "#/chief";
      break;
    case "waiting":
      base = "#/inbox";
      break;
    case "todos":
      base = route.todoId
        ? `#/todos/${encodeURIComponent(route.todoId)}`
        : "#/todos";
      break;
    case "projects":
      base = route.projectId
        ? `#/projects/${encodeURIComponent(route.projectId)}`
        : "#/projects";
      break;
    case "connections":
      base = "#/resources/providers";
      break;
    case "skills":
      base = "#/resources/skills";
      break;
    case "secrets":
      base = "#/resources/secrets";
      break;
    case "mcp":
      base = "#/resources/mcp";
      break;
    case "triggers":
      base = "#/resources/triggers";
      break;
    case "documents":
      base = "#/resources/documents";
      break;
    case "team":
      base = "#/app";
      break;
    case "agents":
      base = "#/agents";
      break;
    case "settings":
      base = "#/settings";
      break;
    default:
      base = "#/chief";
  }

  // Keep panel=todo: for sections that use drawer (not when already in /todos/:id)
  if (route.todoId && route.section !== "todos") {
    const sep = base.includes("?") ? "&" : "?";
    return `${base}${sep}panel=todo:${encodeURIComponent(route.todoId)}`;
  }
  return base;
}

export function isNavSectionActive(current: WorkbenchRoute, section: WorkbenchSection): boolean {
  return current.section === section;
}
