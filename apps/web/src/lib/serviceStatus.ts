export type ServiceStatus =
  | { kind: "online"; version: string; capabilities: string[] }
  | { kind: "offline" }
  | { kind: "error"; detail: string };

export interface HealthResponse {
  version: string;
  capabilities: string[];
}

const requiredCapabilities = ["projects", "todos"];

export function healthToStatus(health: HealthResponse): ServiceStatus {
  const missing = requiredCapabilities.filter((capability) => !health.capabilities.includes(capability));
  if (missing.length > 0) {
    return { kind: "error", detail: `本地服务缺少基础能力：${missing.join("、")}` };
  }
  return { kind: "online", version: health.version, capabilities: health.capabilities };
}

export function serviceFailureStatus(error: unknown): ServiceStatus {
  if (error instanceof TypeError) return { kind: "offline" };
  return { kind: "error", detail: error instanceof Error ? error.message : "无法连接本地服务" };
}

export function serviceStatusCopy(status: ServiceStatus): { label: string; detail: string } {
  switch (status.kind) {
    case "online":
      return { label: "本地服务在线", detail: `版本 ${status.version} · ${status.capabilities.join("、")}` };
    case "offline":
      return {
        label: "本地服务离线",
        detail: "请从 Windows 托盘启动 Personal AI Workbench Service，然后重试。"
      };
    case "error":
      return { label: "连接异常", detail: status.detail };
  }
}
