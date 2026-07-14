import type { AutostartManager } from "./autostart.js";
import { emergencyStopAll, type EmergencyStopResult } from "./emergencyStop.js";
import type { ProcessManager, ServiceStatus } from "./processManager.js";
import { resolveInstallGuideUrl, resolvePwaUrl } from "./paths.js";

export type TrayMenuAction =
  | "start"
  | "stop"
  | "restart"
  | "emergency-stop"
  | "open-pwa"
  | "open-guide"
  | "autostart-on"
  | "autostart-off"
  | "autostart-toggle"
  | "status"
  | "quit";

export interface BrowserOpener {
  open(url: string): Promise<void>;
}

export interface TrayControllerOptions {
  processManager: ProcessManager;
  autostart: AutostartManager;
  browser: BrowserOpener;
  serviceUrl: string;
  pwaUrl?: string;
  installGuideUrl?: string;
  port?: number;
  /** Invoked on quit so the host can exit the process. */
  onQuit?: () => void;
  emergencyStop?: typeof emergencyStopAll;
}

export interface TrayActionResult {
  action: TrayMenuAction;
  ok: boolean;
  message: string;
  serviceStatus?: ServiceStatus;
  emergencyStop?: EmergencyStopResult;
  autostartEnabled?: boolean;
}

/**
 * Maps tray menu items to process/autostart/browser operations.
 * Free of native tray APIs so unit tests can drive every action.
 */
export class TrayController {
  private readonly emergencyStop: typeof emergencyStopAll;
  private readonly pwaUrl: string;
  private readonly installGuideUrl: string;

  constructor(private readonly options: TrayControllerOptions) {
    this.emergencyStop = options.emergencyStop ?? emergencyStopAll;
    this.pwaUrl = options.pwaUrl ?? resolvePwaUrl(options.port);
    this.installGuideUrl = options.installGuideUrl ?? resolveInstallGuideUrl(options.port);
  }

  /** Static menu labels for packaging / native host wiring. */
  static menuItems(): Array<{ action: TrayMenuAction; label: string }> {
    return [
      { action: "start", label: "启动服务" },
      { action: "stop", label: "停止服务" },
      { action: "restart", label: "重启服务" },
      { action: "emergency-stop", label: "紧急停止全部任务" },
      { action: "open-pwa", label: "打开工作台" },
      { action: "open-guide", label: "打开 PWA 安装指引" },
      { action: "autostart-toggle", label: "切换开机自启" },
      { action: "status", label: "服务状态" },
      { action: "quit", label: "退出托盘" }
    ];
  }

  async handle(action: TrayMenuAction): Promise<TrayActionResult> {
    try {
      switch (action) {
        case "start": {
          const serviceStatus = await this.options.processManager.start();
          return { action, ok: true, message: serviceStatus.detail, serviceStatus };
        }
        case "stop": {
          const serviceStatus = await this.options.processManager.stop();
          return { action, ok: true, message: serviceStatus.detail, serviceStatus };
        }
        case "restart": {
          const serviceStatus = await this.options.processManager.restart();
          return { action, ok: true, message: serviceStatus.detail, serviceStatus };
        }
        case "emergency-stop": {
          const emergency = await this.emergencyStop({
            serviceUrl: this.options.serviceUrl,
            summary: "托盘紧急停止：停止全部任务。"
          });
          return {
            action,
            ok: emergency.failed === 0,
            message: `紧急停止完成：停止 ${emergency.stopped}，失败 ${emergency.failed}，跳过 ${emergency.skipped}。`,
            emergencyStop: emergency
          };
        }
        case "open-pwa": {
          await this.options.browser.open(this.pwaUrl);
          return {
            action,
            ok: true,
            message: `已打开工作台：${this.pwaUrl}`
          };
        }
        case "open-guide": {
          await this.options.browser.open(this.installGuideUrl);
          return {
            action,
            ok: true,
            message: `已打开 PWA 安装指引：${this.installGuideUrl}`
          };
        }
        case "autostart-on": {
          const autostartEnabled = await this.options.autostart.setEnabled(true);
          return {
            action,
            ok: true,
            message: "已启用开机自启。",
            autostartEnabled
          };
        }
        case "autostart-off": {
          const autostartEnabled = await this.options.autostart.setEnabled(false);
          return {
            action,
            ok: true,
            message: "已关闭开机自启。",
            autostartEnabled
          };
        }
        case "autostart-toggle": {
          const autostartEnabled = await this.options.autostart.toggle();
          return {
            action,
            ok: true,
            message: autostartEnabled ? "已启用开机自启。" : "已关闭开机自启。",
            autostartEnabled
          };
        }
        case "status": {
          const serviceStatus = await this.options.processManager.status();
          const autostartEnabled = await this.options.autostart.isEnabled();
          return {
            action,
            ok: true,
            message: `${serviceStatus.detail}；开机自启：${autostartEnabled ? "开" : "关"}`,
            serviceStatus,
            autostartEnabled
          };
        }
        case "quit": {
          this.options.onQuit?.();
          return { action, ok: true, message: "托盘已退出。" };
        }
        default: {
          const _exhaustive: never = action;
          return { action: _exhaustive, ok: false, message: "未知操作" };
        }
      }
    } catch (error) {
      return {
        action,
        ok: false,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }
}
