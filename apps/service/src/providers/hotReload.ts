/**
 * In-process hot-apply for non-secret provider/connection config.
 * Listeners (ModelRuntime wrappers, future Doctor, etc.) observe revision bumps
 * without restarting the workbench process.
 */

export type ConfigChangeAction =
  | "create"
  | "update"
  | "remove"
  | "hot_apply"
  | "reload"
  | "test"
  | "probe"
  | "credential_update";

export interface ConfigChangeEvent {
  revision: number;
  action: ConfigChangeAction;
  connectionId?: string;
  /** Secret-free summary for diagnostics. */
  summary: string;
  at: string;
}

export type ConfigChangeListener = (event: ConfigChangeEvent) => void | Promise<void>;

export class ConfigHotReloader {
  private revision = 0;
  private readonly listeners = new Set<ConfigChangeListener>();

  getRevision(): number {
    return this.revision;
  }

  subscribe(listener: ConfigChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async notify(action: ConfigChangeAction, summary: string, connectionId?: string): Promise<ConfigChangeEvent> {
    this.revision += 1;
    const event: ConfigChangeEvent = {
      revision: this.revision,
      action,
      connectionId,
      summary,
      at: new Date().toISOString()
    };
    for (const listener of [...this.listeners]) {
      try {
        await listener(event);
      } catch {
        // Listeners must not break config apply path.
      }
    }
    return event;
  }
}
