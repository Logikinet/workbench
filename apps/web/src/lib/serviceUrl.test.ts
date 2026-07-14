import { describe, expect, it } from "vitest";
import { isLoopbackHostname, resolveRuntimeServiceUrl } from "./serviceUrl.js";

describe("runtime service URL (S3)", () => {
  it("uses window.location.origin on installed loopback when port is the service port", () => {
    expect(
      resolveRuntimeServiceUrl({
        location: {
          hostname: "127.0.0.1",
          origin: "http://127.0.0.1:41999",
          port: "41999"
        }
      })
    ).toBe("http://127.0.0.1:41999");
  });

  it("keeps the default service port when running under Vite dev on 5173", () => {
    expect(
      resolveRuntimeServiceUrl({
        location: {
          hostname: "127.0.0.1",
          origin: "http://127.0.0.1:5173",
          port: "5173"
        }
      })
    ).toBe("http://127.0.0.1:41731");
  });

  it("honors explicit VITE_SERVICE_URL over location", () => {
    expect(
      resolveRuntimeServiceUrl({
        viteServiceUrl: "http://127.0.0.1:45000/",
        location: {
          hostname: "127.0.0.1",
          origin: "http://127.0.0.1:5173",
          port: "5173"
        }
      })
    ).toBe("http://127.0.0.1:45000");
  });

  it("recognizes loopback hostnames", () => {
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("example.test")).toBe(false);
  });
});
