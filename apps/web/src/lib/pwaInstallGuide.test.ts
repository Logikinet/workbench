import { describe, expect, it } from "vitest";
import { buildPwaInstallGuide, pwaInstallGuideAnchorId } from "./pwaInstallGuide.js";

describe("PWA install guide content", () => {
  it("explains loopback auto-connect and tray lifecycle", () => {
    const guide = buildPwaInstallGuide({ serviceUrl: "http://127.0.0.1:41731" });
    expect(guide.loopbackUrl).toBe("http://127.0.0.1:41731/");
    expect(guide.steps.map((step) => step.id)).toEqual([
      "install-app",
      "start-tray",
      "open-desktop",
      "install-pwa",
      "autostart"
    ]);
    expect(guide.steps.find((step) => step.id === "open-desktop")?.body).toContain(
      "http://127.0.0.1:41731/"
    );
    expect(guide.summary).toMatch(/127\.0\.0\.1|loopback/i);
    expect(guide.steps.find((step) => step.id === "start-tray")?.body).toMatch(/NotifyIcon|通知区|系统托盘/);
    expect(guide.steps.find((step) => step.id === "open-desktop")?.body).toMatch(
      /window\.location\.origin|同源/
    );
    expect(guide.notes.some((note) => /Project 工作区/.test(note))).toBe(true);
    expect(guide.notes.some((note) => /Credential Manager|密钥/.test(note))).toBe(true);
  });

  it("uses a stable anchor for tray open-guide deep links", () => {
    expect(pwaInstallGuideAnchorId()).toBe("pwa-install-guide");
  });
});
