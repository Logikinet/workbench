export interface PwaInstallStep {
  id: string;
  title: string;
  body: string;
}

export interface PwaInstallGuide {
  title: string;
  summary: string;
  loopbackUrl: string;
  serviceUrl: string;
  steps: PwaInstallStep[];
  notes: string[];
}

export function buildPwaInstallGuide(options: {
  serviceUrl?: string;
  port?: number;
} = {}): PwaInstallGuide {
  const port = options.port ?? 41731;
  const serviceUrl = (options.serviceUrl ?? `http://127.0.0.1:${port}`).replace(/\/$/, "");
  const loopbackUrl = `${serviceUrl}/`;

  return {
    title: "安装本机 PWA 与托盘服务",
    summary:
      "Personal AI Workbench 以 Windows 本机 Agent Service 为核心。桌面入口与 PWA 均连接 loopback（127.0.0.1），不会监听局域网。",
    loopbackUrl,
    serviceUrl,
    steps: [
      {
        id: "install-app",
        title: "1. 运行一体化安装",
        body:
          "在仓库根目录执行 npm run build 后，运行 packaging/windows/Install-PersonalAIWorkbench.ps1。安装程序会部署 service、web 与 tray，并创建开始菜单/桌面快捷方式。"
      },
      {
        id: "start-tray",
        title: "2. 从系统托盘启动本地服务",
        body:
          "从开始菜单打开「Personal AI Workbench Tray」以显示通知区图标（NotifyIcon）。托盘菜单支持启动、停止、重启服务，以及紧急停止全部任务。命令行 paw-tray.cmd 仍可用于脚本化操作。"
      },
      {
        id: "open-desktop",
        title: "3. 使用桌面入口自动连接",
        body: `桌面快捷方式会打开 ${loopbackUrl}。安装后的 PWA 与 API 同源（window.location.origin），即使自定义安装端口也会自动连接本地 Agent Service，无需再配置远程地址。`
      },
      {
        id: "install-pwa",
        title: "4. 将站点安装为 PWA（Edge / Chrome）",
        body:
          "在浏览器打开工作台后，使用地址栏「安装应用」/「Install app」，或菜单「应用 > 安装此站点为应用」。安装后的 PWA 仍访问同一 loopback 地址，离线壳可保留，但执行 Agent 任务仍需托盘服务在线。"
      },
      {
        id: "autostart",
        title: "5. 可选：开机自启",
        body:
          "在托盘选择「切换开机自启」，或执行 paw-tray.cmd autostart-on / autostart-off。自启写入当前用户 Run 项，不会提升权限，也不会保存任何密钥。"
      }
    ],
    notes: [
      "服务仅绑定 127.0.0.1；若健康检查失败，请先从托盘启动服务。",
      "卸载默认只删除安装目录，不会删除 Project 工作区或 %LOCALAPPDATA%\\PersonalAIWorkbench 数据。",
      "API Key 等密钥保存在 Windows Credential Manager，不会写入安装程序或安装目录。"
    ]
  };
}

export function pwaInstallGuideAnchorId(): string {
  return "pwa-install-guide";
}
