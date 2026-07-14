import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ProjectService } from "./projectService.js";

export interface RunExecutionAuthorizer {
  assertExecutionAuthorized(runId: string, operation: string, projectId?: string, requireActiveExecution?: boolean): Promise<unknown>;
  withActiveExecution?<T>(runId: string, operation: string, execute: () => Promise<T>, projectId?: string): Promise<T>;
}

/** The only file boundary that an Agent execution receives for a Project. */
export class AgentWorkspace {
  constructor(
    private readonly projects: ProjectService,
    private readonly projectId: string,
    private readonly runId: string,
    private readonly executionAuthorizer: RunExecutionAuthorizer
  ) {}

  async readText(targetPath: string): Promise<string> {
    const read = async () => readFile(await this.projects.assertWorkspaceAccess(this.projectId, targetPath), "utf8");
    if (this.executionAuthorizer.withActiveExecution) {
      return this.executionAuthorizer.withActiveExecution(this.runId, "Agent workspace read", read, this.projectId);
    }
    await this.executionAuthorizer.assertExecutionAuthorized(this.runId, "Agent workspace read", this.projectId, true);
    return read();
  }

  async writeText(targetPath: string, content: string): Promise<void> {
    const write = async () => {
      const approvedPath = await this.projects.assertWorkspaceAccess(this.projectId, targetPath);
      await mkdir(dirname(approvedPath), { recursive: true });
      await writeFile(approvedPath, content, "utf8");
    };
    if (this.executionAuthorizer.withActiveExecution) {
      await this.executionAuthorizer.withActiveExecution(this.runId, "Agent workspace write", write, this.projectId);
      return;
    }
    await this.executionAuthorizer.assertExecutionAuthorized(this.runId, "Agent workspace write", this.projectId, true);
    await write();
  }
}
