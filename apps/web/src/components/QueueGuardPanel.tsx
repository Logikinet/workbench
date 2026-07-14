import { useEffect, useState } from "react";
import {
  createQueueClient,
  type QueueConfigRecord,
  type QueueStatusRecord,
  type StopAllResultRecord
} from "../lib/queue.js";

interface QueueGuardPanelProps {
  serviceUrl: string;
  available: boolean;
  dataEpoch?: number;
}

const emptyConfig: QueueConfigRecord = {
  maxWriteParallel: 1,
  maxReadOnlyParallel: 2,
  maxIsolatedSameProjectWriteParallel: 2,
  executionTimeoutMs: 1_800_000,
  maxRetries: 2,
  minFreeDiskBytes: 512 * 1024 * 1024,
  minFreeMemoryBytes: 256 * 1024 * 1024
};

export function QueueGuardPanel({ serviceUrl, available, dataEpoch = 0 }: QueueGuardPanelProps) {
  const client = createQueueClient(serviceUrl);
  const [config, setConfig] = useState<QueueConfigRecord>(emptyConfig);
  const [status, setStatus] = useState<QueueStatusRecord | null>(null);
  const [stopResult, setStopResult] = useState<StopAllResultRecord | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const reload = async () => {
    if (!available) return;
    try {
      const [nextConfig, nextStatus] = await Promise.all([client.getConfig(), client.status()]);
      setConfig(nextConfig);
      setStatus(nextStatus);
      setNotice("");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法读取队列配置");
    }
  };

  useEffect(() => {
    void reload();
  }, [available, dataEpoch]);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const saved = await client.updateConfig({
        maxWriteParallel: Number(config.maxWriteParallel),
        maxReadOnlyParallel: Number(config.maxReadOnlyParallel),
        maxIsolatedSameProjectWriteParallel: Number(config.maxIsolatedSameProjectWriteParallel),
        executionTimeoutMs: Number(config.executionTimeoutMs),
        maxRetries: Number(config.maxRetries),
        minFreeDiskBytes: Number(config.minFreeDiskBytes),
        minFreeMemoryBytes: Number(config.minFreeMemoryBytes)
      });
      setConfig(saved);
      setStatus(await client.status());
      setNotice("队列与资源保护配置已保存。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法保存队列配置");
    } finally {
      setBusy(false);
    }
  };

  const stopAll = async () => {
    if (!window.confirm("确认立即停止全部未结束的 Run？")) return;
    setBusy(true);
    try {
      const result = await client.stopAll("用户一键停止全部 Run。");
      setStopResult(result);
      setStatus(await client.status());
      setNotice(`已处理 ${result.results.length} 个 Run（停止 ${result.stopped}，失败 ${result.failed}）。`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法停止全部 Run");
    } finally {
      setBusy(false);
    }
  };

  const setNumber = (key: keyof QueueConfigRecord) => (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = Number(event.target.value);
    setConfig((current) => ({ ...current, [key]: Number.isFinite(value) ? value : current[key] }));
  };

  return (
    <section className="workspace-panel" aria-labelledby="queue-panel-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">QUEUE & RESOURCE GUARDS</p>
          <h2 id="queue-panel-title">队列、并行与资源保护</h2>
        </div>
        <button type="button" className="danger-button" disabled={!available || busy} onClick={() => void stopAll()}>
          一键停止全部 Run
        </button>
      </div>
      <p className="protected-note">
        默认仅 1 个写入型代理；只读/调研默认可并行 2 个。同一项目写入仅在 Worktree 隔离时允许并行。磁盘/内存不足时会暂停新任务。
      </p>
      {status?.newTasksPaused && (
        <p className="notice" role="status">新任务已暂停：{status.pauseReason}</p>
      )}
      {status && (
        <p>
          当前占用：写入 {status.writeCount} · 只读 {status.readOnlyCount}
          {status.resource
            ? ` · 可用磁盘 ${formatMb(status.resource.freeDiskBytes)} · 可用内存 ${formatMb(status.resource.freeMemoryBytes)}`
            : ""}
        </p>
      )}
      <form className="queue-form" onSubmit={(event) => void save(event)}>
        <label>
          写入并行上限
          <input
            type="number"
            min={1}
            step={1}
            value={config.maxWriteParallel}
            onChange={setNumber("maxWriteParallel")}
            disabled={!available || busy}
          />
        </label>
        <label>
          只读/调研并行上限
          <input
            type="number"
            min={1}
            step={1}
            value={config.maxReadOnlyParallel}
            onChange={setNumber("maxReadOnlyParallel")}
            disabled={!available || busy}
          />
        </label>
        <label>
          同项目隔离写入并行
          <input
            type="number"
            min={1}
            step={1}
            value={config.maxIsolatedSameProjectWriteParallel}
            onChange={setNumber("maxIsolatedSameProjectWriteParallel")}
            disabled={!available || busy}
          />
        </label>
        <label>
          执行超时（毫秒）
          <input
            type="number"
            min={0}
            step={1000}
            value={config.executionTimeoutMs}
            onChange={setNumber("executionTimeoutMs")}
            disabled={!available || busy}
          />
        </label>
        <label title="同一步骤连续失败达此次数后自动暂停（写入 Run.execution.maxConsecutiveFailures）">
          同一步骤连续失败上限
          <input
            type="number"
            min={1}
            step={1}
            value={config.maxRetries}
            onChange={setNumber("maxRetries")}
            disabled={!available || busy}
            aria-label="同一步骤连续失败上限"
          />
        </label>
        <label>
          最低可用磁盘（字节）
          <input
            type="number"
            min={0}
            step={1048576}
            value={config.minFreeDiskBytes}
            onChange={setNumber("minFreeDiskBytes")}
            disabled={!available || busy}
          />
        </label>
        <label>
          最低可用内存（字节）
          <input
            type="number"
            min={0}
            step={1048576}
            value={config.minFreeMemoryBytes}
            onChange={setNumber("minFreeMemoryBytes")}
            disabled={!available || busy}
          />
        </label>
        <button type="submit" disabled={!available || busy}>保存配置</button>
      </form>
      {notice && <p className="notice" role="status">{notice}</p>}
      {stopResult && (
        <ul className="queue-stop-results">
          {stopResult.results.map((entry) => (
            <li key={entry.runId}>
              <strong>{entry.runId.slice(0, 8)}</strong>
              <span>
                {entry.outcome}
                {entry.processTerminated === true ? " · 进程已终止" : ""}
                {entry.processTerminated === false ? " · 进程终止未确认" : ""}
              </span>
              <small>{entry.message}</small>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}
