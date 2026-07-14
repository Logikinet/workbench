import { freemem } from "node:os";
import { statfs } from "node:fs/promises";

export interface ResourceSnapshot {
  freeDiskBytes: number;
  freeMemoryBytes: number;
  path: string;
  checkedAt: string;
}

export interface ResourceGuardLimits {
  minFreeDiskBytes: number;
  minFreeMemoryBytes: number;
}

export interface ResourceAdmission {
  allowed: boolean;
  reason?: string;
  snapshot: ResourceSnapshot;
}

export interface DiskStatsProvider {
  freeBytes(path: string): Promise<number>;
}

export interface MemoryStatsProvider {
  freeBytes(): number;
}

export class NodeDiskStatsProvider implements DiskStatsProvider {
  async freeBytes(path: string): Promise<number> {
    const stats = await statfs(path);
    // bavail is free blocks available to unprivileged users when present.
    const available = typeof stats.bavail === "bigint" ? Number(stats.bavail) : Number(stats.bavail ?? stats.bfree);
    const blockSize = typeof stats.bsize === "bigint" ? Number(stats.bsize) : Number(stats.bsize);
    return Math.max(0, available * blockSize);
  }
}

export class NodeMemoryStatsProvider implements MemoryStatsProvider {
  freeBytes(): number {
    return freemem();
  }
}

const defaultLimits: ResourceGuardLimits = {
  minFreeDiskBytes: 512 * 1024 * 1024,
  minFreeMemoryBytes: 256 * 1024 * 1024
};

/** Checks host disk/memory before admitting new agent executions. */
export class ResourceGuardService {
  private readonly disk: DiskStatsProvider;
  private readonly memory: MemoryStatsProvider;
  private limits: ResourceGuardLimits;
  private readonly rootPath: string;

  constructor(
    rootPath: string,
    limits: Partial<ResourceGuardLimits> = {},
    disk: DiskStatsProvider = new NodeDiskStatsProvider(),
    memory: MemoryStatsProvider = new NodeMemoryStatsProvider()
  ) {
    this.rootPath = rootPath;
    this.limits = { ...defaultLimits, ...limits };
    this.disk = disk;
    this.memory = memory;
  }

  getLimits(): ResourceGuardLimits {
    return { ...this.limits };
  }

  setLimits(limits: Partial<ResourceGuardLimits>): ResourceGuardLimits {
    if (limits.minFreeDiskBytes !== undefined) {
      this.limits.minFreeDiskBytes = requireNonNegative(limits.minFreeDiskBytes, "minFreeDiskBytes");
    }
    if (limits.minFreeMemoryBytes !== undefined) {
      this.limits.minFreeMemoryBytes = requireNonNegative(limits.minFreeMemoryBytes, "minFreeMemoryBytes");
    }
    return this.getLimits();
  }

  async snapshot(): Promise<ResourceSnapshot> {
    const freeDiskBytes = await this.disk.freeBytes(this.rootPath);
    return {
      freeDiskBytes,
      freeMemoryBytes: this.memory.freeBytes(),
      path: this.rootPath,
      checkedAt: new Date().toISOString()
    };
  }

  async admitNewTask(): Promise<ResourceAdmission> {
    let snapshot: ResourceSnapshot;
    try {
      snapshot = await this.snapshot();
    } catch (error) {
      const message = error instanceof Error ? error.message : "无法检查磁盘与内存资源。";
      return {
        allowed: false,
        reason: `资源检查失败，已暂停新任务：${message}`,
        snapshot: {
          freeDiskBytes: 0,
          freeMemoryBytes: this.memory.freeBytes(),
          path: this.rootPath,
          checkedAt: new Date().toISOString()
        }
      };
    }

    if (snapshot.freeDiskBytes < this.limits.minFreeDiskBytes) {
      return {
        allowed: false,
        reason:
          `磁盘空间不足（可用 ${formatBytes(snapshot.freeDiskBytes)}，要求至少 ${formatBytes(this.limits.minFreeDiskBytes)}）；已暂停新任务。`,
        snapshot
      };
    }
    if (snapshot.freeMemoryBytes < this.limits.minFreeMemoryBytes) {
      return {
        allowed: false,
        reason:
          `可用内存不足（可用 ${formatBytes(snapshot.freeMemoryBytes)}，要求至少 ${formatBytes(this.limits.minFreeMemoryBytes)}）；已暂停新任务。`,
        snapshot
      };
    }
    return { allowed: true, snapshot };
  }
}

function requireNonNegative(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a non-negative number.`);
  }
  return Math.floor(value);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
