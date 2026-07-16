import { useEffect, useState } from "react";
import {
  createQueueClient,
  type QueueConfigRecord,
  type QueueStatusRecord,
  type StopAllResultRecord
} from "../lib/queue.js";
import {
  DangerButton,
  EmptyHint,
  Field,
  FormBlock,
  Grid2,
  ListCard,
  Notice,
  Panel,
  PrimaryButton,
  QuietButton,
  Stack,
  Tag,
  TextInput
} from "./ui.js";

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
    <Panel
      eyebrow="QUEUE & RESOURCE GUARDS"
      title="队列、并行与资源保护"
      description="默认仅 1 个写入型代理；只读/调研默认可并行 2 个。同一项目写入仅在 Worktree 隔离时允许并行。磁盘/内存不足时会暂停新任务。"
      actions={
        <div className="flex flex-wrap gap-2">
          <QuietButton onPress={() => void reload()} isDisabled={!available || busy}>
            刷新
          </QuietButton>
          <DangerButton isDisabled={!available || busy} onPress={() => void stopAll()}>
            一键停止全部 Run
          </DangerButton>
        </div>
      }
    >
      {status?.newTasksPaused ? (
        <Notice tone="warning">新任务已暂停：{status.pauseReason}</Notice>
      ) : null}

      {status ? (
        <p className="m-0 text-sm text-foreground">
          当前占用：写入 {status.writeCount} · 只读 {status.readOnlyCount}
          {status.resource
            ? ` · 可用磁盘 ${formatMb(status.resource.freeDiskBytes)} · 可用内存 ${formatMb(status.resource.freeMemoryBytes)}`
            : ""}
        </p>
      ) : (
        <EmptyHint>尚未加载队列状态。</EmptyHint>
      )}

      <FormBlock onSubmit={(event) => void save(event)}>
        <Grid2>
          <Field label="写入并行上限">
            <TextInput
              type="number"
              value={String(config.maxWriteParallel)}
              onChange={setNumber("maxWriteParallel")}
              disabled={!available || busy}
            />
          </Field>
          <Field label="只读/调研并行上限">
            <TextInput
              type="number"
              value={String(config.maxReadOnlyParallel)}
              onChange={setNumber("maxReadOnlyParallel")}
              disabled={!available || busy}
            />
          </Field>
          <Field label="同项目隔离写入并行">
            <TextInput
              type="number"
              value={String(config.maxIsolatedSameProjectWriteParallel)}
              onChange={setNumber("maxIsolatedSameProjectWriteParallel")}
              disabled={!available || busy}
            />
          </Field>
          <Field label="执行超时（毫秒）">
            <TextInput
              type="number"
              value={String(config.executionTimeoutMs)}
              onChange={setNumber("executionTimeoutMs")}
              disabled={!available || busy}
            />
          </Field>
          <Field label="同一步骤连续失败上限">
            <TextInput
              type="number"
              value={String(config.maxRetries)}
              onChange={setNumber("maxRetries")}
              disabled={!available || busy}
              aria-label="同一步骤连续失败上限"
            />
          </Field>
          <Field label="最低可用磁盘（字节）">
            <TextInput
              type="number"
              value={String(config.minFreeDiskBytes)}
              onChange={setNumber("minFreeDiskBytes")}
              disabled={!available || busy}
            />
          </Field>
          <Field label="最低可用内存（字节）">
            <TextInput
              type="number"
              value={String(config.minFreeMemoryBytes)}
              onChange={setNumber("minFreeMemoryBytes")}
              disabled={!available || busy}
            />
          </Field>
        </Grid2>
        <PrimaryButton type="submit" isDisabled={!available || busy}>
          保存配置
        </PrimaryButton>
      </FormBlock>

      {notice ? <Notice>{notice}</Notice> : null}

      {stopResult ? (
        <Stack>
          {stopResult.results.map((entry) => (
            <ListCard
              key={entry.runId}
              actions={
                <Tag color={entry.outcome === "paused" || entry.outcome === "skipped" ? "success" : "danger"}>
                  {entry.outcome}
                </Tag>
              }
            >
              <strong className="block text-sm text-foreground">{entry.runId.slice(0, 8)}</strong>
              <span className="block text-sm text-muted">
                {entry.outcome}
                {entry.processTerminated === true ? " · 进程已终止" : ""}
                {entry.processTerminated === false ? " · 进程终止未确认" : ""}
              </span>
              <small className="block text-xs text-muted">{entry.message}</small>
            </ListCard>
          ))}
        </Stack>
      ) : null}
    </Panel>
  );
}

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}
