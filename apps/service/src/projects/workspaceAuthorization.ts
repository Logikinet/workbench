import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";

export interface WorkspacePicker {
  pick(requestedPath: string): Promise<string | undefined>;
}

export interface WorkspaceAuthorization {
  workspacePath: string;
  confirmedAt: string;
}

export interface WorkspaceGrant {
  id: string;
  workspacePath: string;
  expiresAt: string;
}

export class WorkspaceAuthorizer {
  private readonly grants = new Map<string, WorkspaceGrant>();

  constructor(
    private readonly picker: WorkspacePicker,
    private readonly now: () => Date = () => new Date()
  ) {}

  async request(workspacePath: string): Promise<WorkspaceGrant> {
    const selectedPath = await this.picker.pick(workspacePath);
    if (!selectedPath) throw new Error("Workspace confirmation was cancelled.");

    const requested = await realpath(workspacePath);
    const selected = await realpath(selectedPath);
    if (requested !== selected) throw new Error("Confirm the exact main workspace selected in the Windows dialog.");

    const grant: WorkspaceGrant = {
      id: randomUUID(),
      workspacePath: selected,
      expiresAt: new Date(this.now().getTime() + 10 * 60_000).toISOString()
    };
    this.grants.set(grant.id, grant);
    return grant;
  }

  async consume(grantId: string, workspacePath: string): Promise<WorkspaceAuthorization> {
    const grant = this.grants.get(grantId);
    if (!grant || new Date(grant.expiresAt) <= this.now()) {
      this.grants.delete(grantId);
      throw new Error("You must explicitly confirm the exact main workspace.");
    }
    // Remove before the first await so a concurrent caller can never replay the same grant.
    this.grants.delete(grantId);

    const requested = await realpath(workspacePath).catch(() => undefined);
    if (requested !== grant.workspacePath) {
      throw new Error("You must explicitly confirm the exact main workspace.");
    }
    return { workspacePath: grant.workspacePath, confirmedAt: this.now().toISOString() };
  }
}

export class WindowsFolderPicker implements WorkspacePicker {
  async pick(requestedPath: string): Promise<string | undefined> {
    if (process.platform !== "win32") {
      throw new Error("Workspace confirmation requires the Windows desktop service.");
    }

    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
      "$dialog.Description = '确认 Personal AI Workbench 的主工作区'",
      "$dialog.SelectedPath = $env:PAW_REQUESTED_WORKSPACE",
      "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }"
    ].join("; ");
    return runPowerShell(script, { ...process.env, PAW_REQUESTED_WORKSPACE: requestedPath });
  }
}

function runPowerShell(script: string, environment: NodeJS.ProcessEnv): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const processHandle = spawn("powershell.exe", ["-NoProfile", "-STA", "-Command", script], {
      env: environment,
      windowsHide: false
    });
    let stdout = "";
    let stderr = "";
    processHandle.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    processHandle.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    processHandle.once("error", reject);
    processHandle.once("close", (code) => {
      if (code === 0) {
        const selected = stdout.trim();
        resolve(selected || undefined);
      } else {
        reject(new Error(stderr.trim() || "Windows workspace picker could not be opened."));
      }
    });
  });
}
