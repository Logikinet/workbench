import { describe, expect, it } from "vitest";
import { healthToStatus, serviceFailureStatus, serviceStatusCopy } from "./serviceStatus.js";

describe("service status copy", () => {
  it("gives an actionable recovery instruction when the local service is offline", () => {
    expect(serviceStatusCopy({ kind: "offline" })).toEqual({
      label: "本地服务离线",
      detail: "请从 Windows 托盘启动 Personal AI Workbench Service，然后重试。"
    });
  });

  it("distinguishes a connection fault from an ordinary offline service", () => {
    expect(serviceStatusCopy({ kind: "error", detail: "connection refused" })).toEqual({
      label: "连接异常",
      detail: "connection refused"
    });
  });

  it("shows the recovery instruction for a browser network failure", () => {
    expect(serviceFailureStatus(new TypeError("Failed to fetch"))).toEqual({ kind: "offline" });
  });

  it("only marks the service online when its health check contains the required basic capabilities", () => {
    expect(healthToStatus({ version: "0.1.0", capabilities: ["projects", "todos"] })).toEqual({
      kind: "online",
      version: "0.1.0",
      capabilities: ["projects", "todos"]
    });
    expect(healthToStatus({ version: "0.1.0", capabilities: ["projects"] })).toEqual({
      kind: "error",
      detail: "本地服务缺少基础能力：todos"
    });
  });
});
