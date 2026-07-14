const DEFAULT_SERVICE_URL = "http://127.0.0.1:41731";

/** Vite / other front-end dev servers that are not the Agent Service origin. */
const FRONTEND_DEV_PORTS = new Set(["5173", "4173", "3000", "5174"]);

export interface RuntimeLocationLike {
  hostname: string;
  origin: string;
  port: string;
  protocol?: string;
}

export interface ResolveServiceUrlOptions {
  /** Compile-time override (e.g. VITE_SERVICE_URL for Vite → service on 41731). */
  viteServiceUrl?: string | undefined;
  /** Browser location; injectable for unit tests. */
  location?: RuntimeLocationLike | undefined;
}

export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
}

/**
 * Resolve the Agent Service base URL for the installed PWA / desktop entry.
 *
 * - Explicit `viteServiceUrl` wins (dev proxy / intentional override).
 * - On loopback when not a front-end dev port, use `location.origin` so custom
 *   install `-Port` still auto-connects to the same-origin service.
 * - Otherwise fall back to the default loopback service port.
 */
export function resolveRuntimeServiceUrl(options: ResolveServiceUrlOptions = {}): string {
  const explicit = options.viteServiceUrl?.trim();
  if (explicit) return explicit.replace(/\/$/, "");

  const location = options.location;
  if (location && isLoopbackHostname(location.hostname)) {
    const port = location.port || defaultPortForProtocol(location.protocol);
    if (!FRONTEND_DEV_PORTS.has(port)) {
      return location.origin.replace(/\/$/, "");
    }
  }

  return DEFAULT_SERVICE_URL;
}

function defaultPortForProtocol(protocol: string | undefined): string {
  if (protocol === "https:") return "443";
  return "80";
}
