import { describe, expect, it } from "vitest";
import {
  isProtectedDataPath,
  normalizePathForCompare,
  resolveDataDirectory,
  resolveInstallGuideUrl,
  resolveInstallRoot,
  resolvePidFile,
  resolvePwaUrl,
  resolveServiceEntry,
  resolveServiceUrl,
  resolveTrayEntry,
  resolveWebDist
} from "./paths.js";

describe("install and data path layout", () => {
  it("keeps install bits under Programs and durable state under a sibling data root", () => {
    const env = { localAppData: "C:\\Users\\Ada\\AppData\\Local" };
    expect(resolveInstallRoot(env)).toBe(
      "C:\\Users\\Ada\\AppData\\Local\\Programs\\PersonalAIWorkbench"
    );
    expect(resolveDataDirectory(env)).toBe("C:\\Users\\Ada\\AppData\\Local\\PersonalAIWorkbench");
    expect(resolveDataDirectory(env)).not.toContain("\\Programs\\");
  });

  it("honors explicit install and data overrides for packaging tests", () => {
    const env = {
      localAppData: "C:\\Users\\Ada\\AppData\\Local",
      installRoot: "D:\\Apps\\PAW",
      dataDirectory: "E:\\State\\PAW"
    };
    expect(resolveInstallRoot(env)).toBe("D:\\Apps\\PAW");
    expect(resolveDataDirectory(env)).toBe("E:\\State\\PAW");
  });

  it("resolves service/web/tray entrypoints and pid file under the expected roots", () => {
    const install = "C:\\Install\\PersonalAIWorkbench";
    const data = "C:\\Data\\PersonalAIWorkbench";
    expect(resolveServiceEntry(install)).toBe(
      "C:\\Install\\PersonalAIWorkbench\\service\\dist\\main.js"
    );
    expect(resolveWebDist(install)).toBe("C:\\Install\\PersonalAIWorkbench\\web\\dist");
    expect(resolveTrayEntry(install)).toBe("C:\\Install\\PersonalAIWorkbench\\tray\\dist\\main.js");
    expect(resolvePidFile(data)).toBe("C:\\Data\\PersonalAIWorkbench\\service.pid");
  });

  it("points the desktop/PWA entry at loopback only", () => {
    expect(resolvePwaUrl(41731)).toBe("http://127.0.0.1:41731/");
    expect(resolveServiceUrl(41731)).toBe("http://127.0.0.1:41731");
    expect(resolveInstallGuideUrl(41731)).toBe("http://127.0.0.1:41731/#pwa-install-guide");
  });

  it("detects protected data paths for uninstall safety", () => {
    const data = "C:\\Users\\Ada\\AppData\\Local\\PersonalAIWorkbench";
    expect(isProtectedDataPath(data, data)).toBe(true);
    expect(isProtectedDataPath(`${data}\\artifacts\\report.json`, data)).toBe(true);
    expect(isProtectedDataPath("C:\\Users\\Ada\\Projects\\my-app", data)).toBe(false);
    expect(isProtectedDataPath("C:\\Users\\Ada\\AppData\\Local\\Programs\\PersonalAIWorkbench", data)).toBe(
      false
    );
  });

  it("normalizes slash variants for Windows comparisons", () => {
    expect(normalizePathForCompare("C:/Data/PAW/")).toBe("c:\\data\\paw");
  });

  it("fails with an actionable message when no path roots are available", () => {
    expect(() => resolveInstallRoot({})).toThrow(/PAW_INSTALL_ROOT/);
    expect(() => resolveDataDirectory({})).toThrow(/PAW_DATA_DIR/);
  });
});
