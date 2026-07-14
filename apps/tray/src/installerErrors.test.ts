import { describe, expect, it } from "vitest";
import {
  formatInstallerFailure,
  installerErrorMessage,
  InstallerErrorCode
} from "./installerErrors.js";

describe("installer failure messages", () => {
  it("provides actionable guidance for install upgrade and uninstall failures", () => {
    expect(installerErrorMessage(InstallerErrorCode.NODE_MISSING)).toMatch(/Node\.js/);
    expect(installerErrorMessage(InstallerErrorCode.SOURCE_MISSING)).toMatch(/npm run build/);
    expect(installerErrorMessage(InstallerErrorCode.UPGRADE_BACKUP_FAILED)).toMatch(/未修改现有安装/);
    expect(installerErrorMessage(InstallerErrorCode.UNINSTALL_REFUSED_DATA)).toMatch(
      /Project 工作区|Artifact/
    );
    expect(installerErrorMessage(InstallerErrorCode.UNINSTALL_RUNNING)).toMatch(/停止服务/);
  });

  it("prefixes failures with a stable code for scripts and support", () => {
    expect(formatInstallerFailure(InstallerErrorCode.INSTALL_COPY_FAILED, "Access denied")).toBe(
      `[INSTALL_COPY_FAILED] ${installerErrorMessage(InstallerErrorCode.INSTALL_COPY_FAILED)} 详情：Access denied`
    );
  });
});
