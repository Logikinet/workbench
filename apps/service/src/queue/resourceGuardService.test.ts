import { describe, expect, it } from "vitest";
import {
  formatBytes,
  ResourceGuardService,
  type DiskStatsProvider,
  type MemoryStatsProvider
} from "./resourceGuardService.js";

class FakeDisk implements DiskStatsProvider {
  constructor(public free: number | (() => Promise<number>) = 10 * 1024 * 1024 * 1024) {}
  async freeBytes(): Promise<number> {
    return typeof this.free === "function" ? this.free() : this.free;
  }
}

class FakeMemory implements MemoryStatsProvider {
  constructor(public free = 2 * 1024 * 1024 * 1024) {}
  freeBytes(): number {
    return this.free;
  }
}

describe("ResourceGuardService", () => {
  it("admits new tasks when disk and memory are above configured floors", async () => {
    const guard = new ResourceGuardService(
      "C:\\data",
      { minFreeDiskBytes: 1024, minFreeMemoryBytes: 1024 },
      new FakeDisk(5_000),
      new FakeMemory(5_000)
    );
    const decision = await guard.admitNewTask();
    expect(decision.allowed).toBe(true);
    expect(decision.snapshot.freeDiskBytes).toBe(5_000);
  });

  it("pauses new tasks with a clear disk shortage reason", async () => {
    const guard = new ResourceGuardService(
      "C:\\data",
      { minFreeDiskBytes: 2 * 1024 * 1024 * 1024, minFreeMemoryBytes: 1 },
      new FakeDisk(128 * 1024 * 1024),
      new FakeMemory(4 * 1024 * 1024 * 1024)
    );
    const decision = await guard.admitNewTask();
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/磁盘空间不足/);
    expect(decision.reason).toMatch(/已暂停新任务/);
  });

  it("pauses new tasks with a clear memory shortage reason", async () => {
    const guard = new ResourceGuardService(
      "C:\\data",
      { minFreeDiskBytes: 1, minFreeMemoryBytes: 512 * 1024 * 1024 },
      new FakeDisk(8 * 1024 * 1024 * 1024),
      new FakeMemory(64 * 1024 * 1024)
    );
    const decision = await guard.admitNewTask();
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/可用内存不足/);
  });

  it("fails closed when disk stats cannot be read", async () => {
    const disk: DiskStatsProvider = {
      freeBytes: async () => {
        throw new Error("EIO");
      }
    };
    const guard = new ResourceGuardService("C:\\data", {}, disk, new FakeMemory());
    const decision = await guard.admitNewTask();
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/资源检查失败/);
  });

  it("updates resource floors from user config", () => {
    const guard = new ResourceGuardService("C:\\data", {}, new FakeDisk(), new FakeMemory());
    const limits = guard.setLimits({ minFreeDiskBytes: 100, minFreeMemoryBytes: 50 });
    expect(limits).toEqual({ minFreeDiskBytes: 100, minFreeMemoryBytes: 50 });
  });

  it("formats byte sizes for operator-facing messages", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});
