/**
 * Tool Registry types (Task 22).
 * Tools represent permission capabilities; Skills remain separate (methods).
 */

export type ToolPermissionCategory = "readonly" | "write" | "shell" | "network" | "dangerous";

export type ToolSource = "builtin" | "registered" | "mcp";

export interface ToolDefinition {
  id: string;
  name: string;
  description: string;
  /** Semantic version string for timeline snapshots. */
  version: string;
  category: ToolPermissionCategory;
  source: ToolSource;
  /** Whether the tool is enabled globally in the registry. */
  enabled: boolean;
  /**
   * User trust record. Built-ins are pre-trusted.
   * Untrusted tools must not be exposed for first-time use until trusted.
   */
  trusted: boolean;
  trustedAt?: string;
  /**
   * When true, callers must obtain explicit user approval before invoking
   * (cannot bypass workspace / approval boundaries).
   */
  requiresApproval: boolean;
  /**
   * Optional JSON-schema-like parameter description for future MCP/tool-loop binding.
   * Not executed here — schema only.
   */
  inputSchema?: Record<string, unknown>;
  /** Optional tags for catalog filtering. */
  tags?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface RegisterToolInput {
  id: string;
  name: string;
  description: string;
  version?: string;
  category: ToolPermissionCategory;
  source?: ToolSource;
  enabled?: boolean;
  /** Defaults: builtin → trusted; others → untrusted. */
  trusted?: boolean;
  requiresApproval?: boolean;
  inputSchema?: Record<string, unknown>;
  tags?: string[];
}

export interface ToolState {
  schemaVersion: 1;
  tools: ToolDefinition[];
}

export const TOOL_PERMISSION_CATEGORIES: readonly ToolPermissionCategory[] = [
  "readonly",
  "write",
  "shell",
  "network",
  "dangerous"
] as const;

/** Built-in tools aligned with existing Role name-only configs. */
export const BUILTIN_TOOL_SPECS: ReadonlyArray<Omit<RegisterToolInput, "source"> & { source: "builtin" }> = [
  {
    id: "filesystem",
    name: "filesystem",
    description: "Read and write files inside the approved Project workspace.",
    version: "1.0.0",
    category: "write",
    source: "builtin",
    enabled: true,
    trusted: true,
    requiresApproval: false,
    tags: ["workspace", "files"]
  },
  {
    id: "shell",
    name: "shell",
    description: "Run approved shell commands inside the project workspace.",
    version: "1.0.0",
    category: "shell",
    source: "builtin",
    enabled: true,
    trusted: true,
    requiresApproval: true,
    tags: ["terminal"]
  },
  {
    id: "web",
    name: "web",
    description: "Fetch or send content over the network.",
    version: "1.0.0",
    category: "network",
    source: "builtin",
    enabled: true,
    trusted: true,
    requiresApproval: true,
    tags: ["network"]
  },
  {
    id: "git",
    name: "git",
    description: "Inspect and mutate local git worktrees within project bounds.",
    version: "1.0.0",
    category: "write",
    source: "builtin",
    enabled: true,
    trusted: true,
    requiresApproval: false,
    tags: ["vcs"]
  },
  {
    id: "model-api",
    name: "model-api",
    description: "Invoke the configured model API connection.",
    version: "1.0.0",
    category: "network",
    source: "builtin",
    enabled: true,
    trusted: true,
    requiresApproval: false,
    tags: ["model"]
  },
  {
    id: "codex-cli",
    name: "codex-cli",
    description: "Invoke the Codex CLI harness for coding sessions.",
    version: "1.0.0",
    category: "shell",
    source: "builtin",
    enabled: true,
    trusted: true,
    requiresApproval: true,
    tags: ["harness", "codex"]
  },
  {
    id: "read_file",
    name: "read_file",
    description: "Read a file from the approved workspace (read-only).",
    version: "1.0.0",
    category: "readonly",
    source: "builtin",
    enabled: true,
    trusted: true,
    requiresApproval: false,
    tags: ["workspace", "files", "readonly"]
  },
  {
    id: "list_dir",
    name: "list_dir",
    description: "List directory contents in the approved workspace (read-only).",
    version: "1.0.0",
    category: "readonly",
    source: "builtin",
    enabled: true,
    trusted: true,
    requiresApproval: false,
    tags: ["workspace", "files", "readonly"]
  },
  {
    id: "dangerous_exec",
    name: "dangerous_exec",
    description: "High-risk host execution; always requires explicit approval and trust.",
    version: "1.0.0",
    category: "dangerous",
    source: "builtin",
    enabled: false,
    trusted: false,
    requiresApproval: true,
    tags: ["dangerous"]
  }
];
