/**
 * Hash-based workbench routes (no extra router dependency).
 * Examples: #/home, #/todos, #/todos/todo-1, #/waiting
 */

export const workbenchSections = [
  "home",
  "todos",
  "projects",
  "agents",
  "connections",
  "settings",
  "waiting"
] as const;

export type WorkbenchSection = (typeof workbenchSections)[number];

export interface WorkbenchRoute {
  section: WorkbenchSection;
  /** When set, Todo / Run detail is focused. */
  todoId?: string;
}

export const sectionLabels: Record<WorkbenchSection, string> = {
  home: "首页",
  todos: "Todos",
  projects: "Projects",
  agents: "Agents",
  connections: "Connections",
  settings: "Settings",
  waiting: "等待我处理"
};

export function parseWorkbenchHash(hash: string): WorkbenchRoute {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const path = raw.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!path || path === "home") return { section: "home" };

  const parts = path.split("/").filter(Boolean);
  const head = parts[0]?.toLowerCase() ?? "home";

  if (head === "todos") {
    const todoId = parts[1] ? decodeURIComponent(parts[1]) : undefined;
    return todoId ? { section: "todos", todoId } : { section: "todos" };
  }
  if (head === "waiting" || head === "waiting-on-me") return { section: "waiting" };
  if (head === "projects") return { section: "projects" };
  if (head === "agents") return { section: "agents" };
  if (head === "connections") return { section: "connections" };
  if (head === "settings") return { section: "settings" };
  if ((workbenchSections as readonly string[]).includes(head)) {
    return { section: head as WorkbenchSection };
  }
  return { section: "home" };
}

export function formatWorkbenchHash(route: WorkbenchRoute): string {
  if (route.section === "home") return "#/home";
  if (route.section === "todos" && route.todoId) {
    return `#/todos/${encodeURIComponent(route.todoId)}`;
  }
  return `#/${route.section}`;
}

export function isNavSectionActive(current: WorkbenchRoute, section: WorkbenchSection): boolean {
  return current.section === section;
}
