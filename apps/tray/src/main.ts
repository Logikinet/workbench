#!/usr/bin/env node
import { homedir } from "node:os";
import { AutostartManager, buildAutostartLaunchCommand, MemoryAutostartStore } from "./autostart.js";
import {
  DEFAULT_SERVICE_PORT,
  resolveDataDirectory,
  resolveInstallRoot,
  resolvePidFile,
  resolveServiceEntry,
  resolveServiceUrl,
  resolveTrayEntry,
  resolveWebDist
} from "./paths.js";
import { ProcessManager } from "./processManager.js";
import { TrayController, type TrayMenuAction } from "./trayController.js";
import {
  nodeProcessManagerFs,
  nodeProcessSpawner,
  openInDefaultBrowser,
  WindowsRegistryRunKeyStore,
  windowsProcessKiller
} from "./windowsAdapters.js";

function printHelp(): void {
  const items = TrayController.menuItems()
    .map((item) => `  ${item.action.padEnd(18)} ${item.label}`)
    .join("\n");
  console.log(`Personal AI Workbench tray host

Usage:
  node main.js <action>
  node main.js --action=<action>
  node main.js --autostart-launch   Start service on logon (no UI)

Actions:
${items}

Environment:
  PAW_INSTALL_ROOT   Install directory (default %LOCALAPPDATA%\\Programs\\PersonalAIWorkbench)
  PAW_DATA_DIR       Data directory (default %LOCALAPPDATA%\\PersonalAIWorkbench)
  PAW_SERVICE_PORT   Loopback port (default ${DEFAULT_SERVICE_PORT})
`);
}

function parseAction(argv: string[]): TrayMenuAction | "help" | "autostart-launch" {
  if (argv.includes("--help") || argv.includes("-h")) return "help";
  if (argv.includes("--autostart-launch")) return "autostart-launch";
  const flag = argv.find((arg) => arg.startsWith("--action="));
  const raw = flag ? flag.slice("--action=".length) : argv.find((arg) => !arg.startsWith("-"));
  if (!raw) return "status";
  const allowed = new Set(TrayController.menuItems().map((item) => item.action));
  if (!allowed.has(raw as TrayMenuAction)) {
    throw new Error(`未知操作：${raw}。使用 --help 查看可用操作。`);
  }
  return raw as TrayMenuAction;
}

function buildController(onQuit?: () => void): TrayController {
  const env = {
    localAppData: process.env.LOCALAPPDATA,
    homeDir: homedir(),
    installRoot: process.env.PAW_INSTALL_ROOT,
    dataDirectory: process.env.PAW_DATA_DIR
  };
  const installRoot = resolveInstallRoot(env);
  const dataDirectory = resolveDataDirectory(env);
  const port = Number.parseInt(process.env.PAW_SERVICE_PORT ?? String(DEFAULT_SERVICE_PORT), 10);
  const nodeExecutable = process.execPath;
  const trayEntry = resolveTrayEntry(installRoot);
  const launchCommand =
    process.env.PAW_TRAY_LAUNCH_COMMAND?.trim() ||
    buildAutostartLaunchCommand(nodeExecutable, trayEntry);

  const processManager = new ProcessManager({
    nodeExecutable,
    serviceEntry: process.env.PAW_SERVICE_ENTRY?.trim() || resolveServiceEntry(installRoot),
    port,
    dataDirectory,
    webDist: process.env.PAW_WEB_DIST?.trim() || resolveWebDist(installRoot),
    pidFile: resolvePidFile(dataDirectory),
    spawner: nodeProcessSpawner,
    fs: nodeProcessManagerFs,
    killer: windowsProcessKiller
  });

  const store =
    process.platform === "win32" ? new WindowsRegistryRunKeyStore() : new MemoryAutostartStore();

  return new TrayController({
    processManager,
    autostart: new AutostartManager({ store, launchCommand }),
    browser: { open: openInDefaultBrowser },
    serviceUrl: resolveServiceUrl(port),
    port,
    onQuit
  });
}

async function main(): Promise<void> {
  const action = parseAction(process.argv.slice(2));
  if (action === "help") {
    printHelp();
    return;
  }

  let shouldExit = false;
  const controller = buildController(() => {
    shouldExit = true;
  });

  if (action === "autostart-launch") {
    const result = await controller.handle("start");
    console.log(result.message);
    if (!result.ok) process.exitCode = 1;
    // Keep the tray host alive only when a native host is attached; CLI autostart just starts service.
    return;
  }

  const result = await controller.handle(action);
  console.log(result.message);
  if (result.serviceStatus) {
    console.log(JSON.stringify({ serviceStatus: result.serviceStatus }, null, 2));
  }
  if (result.emergencyStop) {
    console.log(JSON.stringify({ emergencyStop: result.emergencyStop }, null, 2));
  }
  if (typeof result.autostartEnabled === "boolean") {
    console.log(JSON.stringify({ autostartEnabled: result.autostartEnabled }));
  }
  if (!result.ok) process.exitCode = 1;
  if (shouldExit) process.exit(result.ok ? 0 : 1);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
