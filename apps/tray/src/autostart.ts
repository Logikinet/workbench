import { AUTOSTART_VALUE_NAME } from "./paths.js";

/**
 * Injectable Windows "Run" key (or Startup shortcut) backend.
 * Production uses HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run.
 */
export interface AutostartStore {
  get(name: string): Promise<string | undefined>;
  set(name: string, command: string): Promise<void>;
  remove(name: string): Promise<void>;
}

export class MemoryAutostartStore implements AutostartStore {
  private readonly values = new Map<string, string>();

  async get(name: string): Promise<string | undefined> {
    return this.values.get(name);
  }

  async set(name: string, command: string): Promise<void> {
    this.values.set(name, command);
  }

  async remove(name: string): Promise<void> {
    this.values.delete(name);
  }
}

export interface AutostartManagerOptions {
  store: AutostartStore;
  valueName?: string;
  /** Command line written to the Run key when enabling autostart. */
  launchCommand: string;
}

export class AutostartManager {
  private readonly valueName: string;
  private readonly launchCommand: string;
  private readonly store: AutostartStore;

  constructor(options: AutostartManagerOptions) {
    this.store = options.store;
    this.valueName = options.valueName ?? AUTOSTART_VALUE_NAME;
    this.launchCommand = options.launchCommand;
  }

  async isEnabled(): Promise<boolean> {
    const current = await this.store.get(this.valueName);
    return typeof current === "string" && current.length > 0;
  }

  async enable(): Promise<void> {
    if (!this.launchCommand.trim()) {
      throw new Error("无法启用开机自启：启动命令为空。请重新安装或设置 PAW_TRAY_LAUNCH_COMMAND。");
    }
    await this.store.set(this.valueName, this.launchCommand);
  }

  async disable(): Promise<void> {
    await this.store.remove(this.valueName);
  }

  /** @returns new enabled state */
  async setEnabled(enabled: boolean): Promise<boolean> {
    if (enabled) await this.enable();
    else await this.disable();
    return this.isEnabled();
  }

  async toggle(): Promise<boolean> {
    const enabled = await this.isEnabled();
    return this.setEnabled(!enabled);
  }
}

/**
 * Builds the HKCU Run command for the tray host.
 * Starts the tray minimized so the service can be managed after logon.
 */
export function buildAutostartLaunchCommand(nodeExecutable: string, trayEntry: string): string {
  const node = quoteWindowsArg(nodeExecutable);
  const entry = quoteWindowsArg(trayEntry);
  return `${node} ${entry} --autostart-launch`;
}

function quoteWindowsArg(value: string): string {
  if (!/[ \t"]/u.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}
