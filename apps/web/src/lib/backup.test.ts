import { describe, expect, it, vi } from "vitest";
import { createBackupClient } from "./backup.js";

const emptyPackage = {
  schemaVersion: 1,
  kind: "personal-ai-workbench-backup",
  exportedAt: "2026-07-15T00:00:00.000Z",
  manifest: {
    secretsExcluded: true,
    includesProjectFiles: false,
    externalWorkspaces: [],
    notes: []
  },
  projects: [],
  todos: [],
  runs: [],
  roles: [],
  connections: [],
  settings: {},
  workbenchRecords: []
};

describe("backup client", () => {
  it("exports and imports backup packages through the local service API", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/backup/export")) {
        return new Response(
          JSON.stringify({
            filename: "personal-ai-workbench-backup.json",
            package: emptyPackage
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.endsWith("/api/backup/import") && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            restored: { projects: 0, todos: 0, runs: 0, roles: 0, connections: 0, workbenchRecords: 0 },
            relinkedWorkspaces: 0,
            needsRepairProjects: [],
            warnings: []
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createBackupClient("http://127.0.0.1:41731");
    const exported = await client.exportPackage();
    expect(exported.package.kind).toBe("personal-ai-workbench-backup");
    const imported = await client.importPackage(exported.package);
    expect(imported.restored.projects).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.unstubAllGlobals();
  });

  it("posts the full package body for import so large histories use the elevated import limit", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toContain("/api/backup/import");
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body)) as { package: typeof emptyPackage };
      expect(body.package.kind).toBe("personal-ai-workbench-backup");
      return new Response(
        JSON.stringify({
          restored: { projects: 1, todos: 1, runs: 0, roles: 0, connections: 0, workbenchRecords: 0 },
          relinkedWorkspaces: 1,
          needsRepairProjects: [],
          warnings: []
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createBackupClient("http://127.0.0.1:41731");
    const result = await client.importPackage(emptyPackage as never);
    expect(result.relinkedWorkspaces).toBe(1);

    vi.unstubAllGlobals();
  });
});
