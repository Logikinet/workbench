import type { RuntimeAdapter } from "./adapter.js";
import type { RuntimeHarnessId } from "./types.js";

/**
 * Registry of Runtime Adapters by harness id.
 * Orchestration selects adapters by Role.harness without importing harness-private modules.
 */
export class RuntimeAdapterRegistry {
  private readonly adapters = new Map<string, RuntimeAdapter>();

  register(adapter: RuntimeAdapter): void {
    if (!adapter.harness?.trim()) throw new Error("Cannot register a RuntimeAdapter without harness id.");
    this.adapters.set(adapter.harness, adapter);
  }

  get(harness: RuntimeHarnessId): RuntimeAdapter {
    const adapter = this.adapters.get(harness);
    if (!adapter) throw new Error(`No RuntimeAdapter registered for harness "${harness}".`);
    return adapter;
  }

  tryGet(harness: RuntimeHarnessId): RuntimeAdapter | undefined {
    return this.adapters.get(harness);
  }

  list(): RuntimeAdapter[] {
    return [...this.adapters.values()];
  }

  has(harness: RuntimeHarnessId): boolean {
    return this.adapters.has(harness);
  }
}
