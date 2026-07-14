export type JsonRequest = <T>(path: string, init?: RequestInit) => Promise<T>;

export function createJsonRequest(serviceUrl: string): JsonRequest {
  return async <T>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetch(`${serviceUrl}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...init?.headers }
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(payload?.error ?? `服务返回 ${response.status}`);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  };
}
