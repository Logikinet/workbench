/**
 * Loopback HTTP client for pawb CLI — never talks to SQLite directly.
 */

import { redactSecrets } from "./redact.js";

export class ServiceOfflineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceOfflineError";
  }
}

export function serviceBaseUrl(): string {
  const port = process.env.PAW_SERVICE_PORT?.trim() || "41731";
  return process.env.PAW_SERVICE_URL?.trim() || `http://127.0.0.1:${port}`;
}

export async function apiJson<T>(
  path: string,
  init?: RequestInit
): Promise<T> {
  const url = `${serviceBaseUrl()}${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(init?.headers ?? {})
      }
    });
  } catch (error) {
    throw new ServiceOfflineError(
      [
        "无法连接 Local Agent Service。",
        `目标：${serviceBaseUrl()}`,
        "请先在仓库根目录启动：npm run dev",
        "或安装后通过托盘启动服务。",
        error instanceof Error ? `详情：${error.message}` : ""
      ]
        .filter(Boolean)
        .join("\n")
    );
  }

  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { error: text };
  }

  if (!response.ok) {
    const err =
      body && typeof body === "object" && body !== null && "error" in body
        ? String((body as { error: unknown }).error)
        : `HTTP ${response.status}`;
    throw new Error(redactSecrets(err));
  }
  return body as T;
}

export async function apiVoid(path: string, init?: RequestInit): Promise<void> {
  await apiJson(path, init);
}
