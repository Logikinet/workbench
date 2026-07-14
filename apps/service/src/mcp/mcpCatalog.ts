/**
 * Local MCP catalog (Task 40).
 * Offline-first discovery templates — no third-party marketplace brand/service.
 */

import type {
  McpCatalogEntry,
  McpCatalogSearchQuery,
  McpCatalogSearchResult,
  McpConnection,
  McpInstallStatus
} from "./mcpTypes.js";

export interface McpCatalogProvider {
  isAvailable(): boolean;
  list(): McpCatalogEntry[];
  get(catalogId: string): McpCatalogEntry | undefined;
}

/** Local catalog seeds (fake transport for offline unit tests / demos). */
export const LOCAL_MCP_CATALOG_SEEDS: readonly McpCatalogEntry[] = [
  {
    id: "catalog-mcp-workspace-files",
    name: "workspace-files",
    version: "1.0.0",
    description: "Read-only workspace file helpers via MCP.",
    tags: ["filesystem", "readonly"],
    recommended: true,
    transport: "fake",
    fakeServerId: "catalog-workspace-files",
    permissionSummary: [
      "Transport: fake (test/local)",
      "Tools may read workspace files (risk: read)",
      "Does not grant write/shell/network by default"
    ],
    trustLevel: "official"
  },
  {
    id: "catalog-mcp-http-fetch",
    name: "http-fetch",
    version: "1.0.0",
    description: "HTTP fetch helper MCP for approved network research.",
    tags: ["network", "research"],
    recommended: true,
    transport: "fake",
    fakeServerId: "catalog-http-fetch",
    permissionSummary: [
      "Transport: fake (test/local)",
      "Tools may perform network requests (risk: network)",
      "Requires Role.network permission and per-tool binding"
    ],
    trustLevel: "community"
  },
  {
    id: "catalog-mcp-notes",
    name: "notes-mcp",
    version: "1.1.0",
    description: "Local notes server template.",
    tags: ["notes", "write"],
    recommended: false,
    transport: "fake",
    fakeServerId: "catalog-notes",
    permissionSummary: [
      "Transport: fake (test/local)",
      "Tools may write note files (risk: write)",
      "Requires project_only workspace permission and per-tool binding"
    ],
    trustLevel: "community"
  }
];

export class LocalMcpCatalogProvider implements McpCatalogProvider {
  private available = true;
  private readonly entries = new Map<string, McpCatalogEntry>();

  constructor(seeds: readonly McpCatalogEntry[] = LOCAL_MCP_CATALOG_SEEDS) {
    for (const entry of seeds) {
      this.entries.set(entry.id, cloneEntry(entry));
    }
  }

  isAvailable(): boolean {
    return this.available;
  }

  setAvailable(available: boolean): void {
    this.available = available;
  }

  list(): McpCatalogEntry[] {
    return [...this.entries.values()]
      .map(cloneEntry)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  get(catalogId: string): McpCatalogEntry | undefined {
    const entry = this.entries.get(catalogId);
    return entry ? cloneEntry(entry) : undefined;
  }

  upsert(entry: McpCatalogEntry): void {
    this.entries.set(entry.id, cloneEntry(entry));
  }
}

export function searchMcpCatalog(
  provider: McpCatalogProvider,
  connections: readonly McpConnection[],
  query: McpCatalogSearchQuery = {}
): McpCatalogSearchResult {
  const installedCount = connections.length;
  if (!provider.isAvailable()) {
    return { catalogAvailable: false, entries: [], installedCount };
  }

  const q = query.query?.trim().toLowerCase() ?? "";
  const tags = (query.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean);
  const recommendedOnly = query.recommendedOnly === true;
  const notInstalledOnly = query.notInstalledOnly === true;

  const entries = provider
    .list()
    .filter((entry) => {
      if (recommendedOnly && !entry.recommended) return false;
      if (tags.length > 0) {
        const entryTags = entry.tags.map((t) => t.toLowerCase());
        if (!tags.every((tag) => entryTags.includes(tag))) return false;
      }
      if (q) {
        const hay = `${entry.id} ${entry.name} ${entry.description} ${entry.tags.join(" ")}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      const match = findInstalled(entry, connections);
      if (notInstalledOnly && match) return false;
      return true;
    })
    .map((entry) => {
      const match = findInstalled(entry, connections);
      return {
        ...cloneEntry(entry),
        recommended: entry.recommended === true,
        installed: Boolean(match),
        installedConnectionId: match?.id,
        installedVersion: match?.version
      };
    })
    .sort((a, b) => {
      if (a.recommended !== b.recommended) return a.recommended ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  return { catalogAvailable: true, entries, installedCount };
}

export function resolveMcpInstallStatus(connection: McpConnection, catalog?: McpCatalogEntry): McpInstallStatus {
  if (!connection.enabled) return "disabled";
  if (connection.trusted === false) return "untrusted";
  if (
    catalog
    && connection.version
    && compareSemverLike(catalog.version, connection.version) > 0
  ) {
    return "update_available";
  }
  return "installed";
}

export function buildMcpPermissionLines(
  connection: Pick<McpConnection, "name" | "transport" | "tools" | "trusted" | "source" | "version" | "description">,
  catalogLines?: string[]
): string[] {
  const lines = [
    `MCP: ${connection.name}${connection.version ? ` (${connection.version})` : ""}`,
    `Transport: ${connection.transport}`,
    `Source: ${connection.source ?? "manual"}`
  ];
  if (connection.description) lines.push(`Description: ${connection.description}`);
  if (catalogLines?.length) {
    lines.push(...catalogLines);
  }
  const tools = connection.tools ?? [];
  if (tools.length > 0) {
    lines.push(`Discovered tools (${tools.length}):`);
    for (const tool of tools.slice(0, 20)) {
      lines.push(`  - ${tool.name}${tool.risk ? ` [${tool.risk}]` : ""}${tool.description ? `: ${tool.description}` : ""}`);
    }
    if (tools.length > 20) lines.push(`  … and ${tools.length - 20} more`);
  } else {
    lines.push("Tools: not discovered yet (run test/connect after install).");
  }
  lines.push("Tools are never exposed wholesale — bind each tool to an Agent Role.");
  if (connection.trusted === false) {
    lines.push("Trust required before first tool call — unknown MCP servers will not run silently.");
  }
  return lines;
}

export function compareSemverLike(left: string, right: string): number {
  const l = left.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const r = right.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const len = Math.max(l.length, r.length);
  for (let i = 0; i < len; i++) {
    const lv = l[i] ?? 0;
    const rv = r[i] ?? 0;
    if (lv !== rv) return lv < rv ? -1 : 1;
  }
  return 0;
}

export function previewConfigDiff(
  current: { version?: string; command?: string; args?: string[]; url?: string; transport?: string },
  target: McpCatalogEntry
): string {
  const lines: string[] = ["--- current", "+++ catalog target"];
  const fields: Array<[string, string | undefined, string | undefined]> = [
    ["version", current.version, target.version],
    ["transport", current.transport, target.transport],
    ["command", current.command, target.command],
    ["args", current.args?.join(" "), target.args?.join(" ")],
    ["url", current.url, target.url]
  ];
  for (const [key, left, right] of fields) {
    if ((left ?? "") === (right ?? "")) {
      lines.push(` ${key}: ${left ?? ""}`);
    } else {
      lines.push(`-${key}: ${left ?? ""}`);
      lines.push(`+${key}: ${right ?? ""}`);
    }
  }
  return lines.join("\n");
}

function findInstalled(
  entry: McpCatalogEntry,
  connections: readonly McpConnection[]
): McpConnection | undefined {
  return connections.find(
    (c) => c.catalogId === entry.id || c.name.toLowerCase() === entry.name.toLowerCase()
  );
}

function cloneEntry(entry: McpCatalogEntry): McpCatalogEntry {
  return {
    ...entry,
    tags: [...entry.tags],
    args: entry.args ? [...entry.args] : undefined,
    envKeys: entry.envKeys ? [...entry.envKeys] : undefined,
    permissionSummary: [...entry.permissionSummary]
  };
}
