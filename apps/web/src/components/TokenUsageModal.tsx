/**
 * todos 风格「Token 用量」弹窗：总量 + 输入/输出/缓存 + 按模型明细
 */

import { useEffect, useState } from "react";
import {
  createRunClient,
  formatTokenCount,
  type RunUsageRecord
} from "../lib/runs.js";

interface TokenUsageModalProps {
  open: boolean;
  serviceUrl: string;
  runId?: string;
  /** Optional seed from embedded run.usage while fetching fresh. */
  seed?: RunUsageRecord;
  onClose(): void;
}

const emptyUsage = (): RunUsageRecord => ({
  promptTokens: 0,
  completionTokens: 0,
  cacheTokens: 0,
  totalTokens: 0,
  estimated: false,
  byModel: [],
  updatedAt: new Date().toISOString()
});

export function TokenUsageModal({
  open,
  serviceUrl,
  runId,
  seed,
  onClose
}: TokenUsageModalProps) {
  const [usage, setUsage] = useState<RunUsageRecord>(seed ?? emptyUsage());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    if (seed) setUsage(seed);
    if (!runId) {
      setUsage(emptyUsage());
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError("");
    const client = createRunClient(serviceUrl);
    void client
      .usage(runId)
      .then((data) => {
        if (!cancelled) setUsage(data);
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "无法读取用量");
          if (seed) setUsage(seed);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, runId, serviceUrl, seed?.updatedAt, seed?.totalTokens]);

  if (!open) return null;

  const total = usage.totalTokens;
  const input = usage.promptTokens;
  const output = usage.completionTokens;
  const cache = usage.cacheTokens;
  const partsSum = input + output + cache || 1;

  return (
    <div className="tds-modal-mask" role="presentation" onClick={onClose}>
      <div
        className="tds-modal tds-usage-modal"
        role="dialog"
        aria-labelledby="tds-usage-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="tds-modal-head">
          <strong id="tds-usage-title">Token 用量</strong>
          <button type="button" className="tds-modal-x" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>

        <div className="tds-usage-hero">
          <div className="tds-usage-total">{formatTokenCount(total)}</div>
          <div className="tds-usage-sub">
            {loading ? "加载中…" : usage.estimated ? "含估算值" : total > 0 ? "本任务累计" : "暂无调用记录"}
          </div>
        </div>

        <div className="tds-usage-bar" aria-hidden="true">
          <span className="in" style={{ width: `${(input / partsSum) * 100}%` }} />
          <span className="out" style={{ width: `${(output / partsSum) * 100}%` }} />
          <span className="cache" style={{ width: `${(cache / partsSum) * 100}%` }} />
        </div>

        <div className="tds-usage-stats">
          <div className="tds-usage-stat">
            <span className="dot in" />
            <span className="label">输入</span>
            <strong>{formatTokenCount(input)}</strong>
          </div>
          <div className="tds-usage-stat">
            <span className="dot out" />
            <span className="label">输出</span>
            <strong>{formatTokenCount(output)}</strong>
          </div>
          <div className="tds-usage-stat">
            <span className="dot cache" />
            <span className="label">缓存</span>
            <strong>{formatTokenCount(cache)}</strong>
          </div>
        </div>

        {error ? <div className="tds-usage-error">{error}</div> : null}

        {usage.byModel.length > 0 ? (
          <div className="tds-usage-models">
            <h4>按模型</h4>
            <ul>
              {usage.byModel.map((m) => (
                <li key={m.modelId}>
                  <div className="tds-usage-model-head">
                    <strong>{m.label || m.modelId}</strong>
                    <span>{formatTokenCount(m.totalTokens)}</span>
                  </div>
                  <div className="tds-usage-model-meta">
                    <code>{m.modelId}</code>
                    <span>
                      {m.calls} 次调用
                      {m.estimated ? " · 估算" : ""}
                    </span>
                  </div>
                  <div className="tds-usage-model-split">
                    <span>入 {formatTokenCount(m.promptTokens)}</span>
                    <span>出 {formatTokenCount(m.completionTokens)}</span>
                    {m.cacheTokens > 0 ? <span>缓存 {formatTokenCount(m.cacheTokens)}</span> : null}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <p className="tds-usage-foot">
          统计本 Run 内模型调用的 prompt / completion token。部分路径仅有估算值。
        </p>
      </div>
    </div>
  );
}
