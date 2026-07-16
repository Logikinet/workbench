/**
 * 执行后文件变更预览：列表 + unified diff 绿/红高亮
 * 对照红字：新建完文件后预览并高亮标注
 */

import { useEffect, useMemo, useState } from "react";
import { createRunClient, type GitWorktreeDiffRecord } from "../lib/runs.js";

interface DiffPreviewProps {
  serviceUrl: string;
  runId: string;
}

function colorizeDiffLine(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return "meta";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  if (line.startsWith("diff ") || line.startsWith("index ")) return "meta";
  return "ctx";
}

/** Split multi-file unified diff into per-file blocks when possible. */
function splitDiffByFile(diff: string): Array<{ path: string; body: string }> {
  if (!diff.trim()) return [];
  const parts = diff.split(/(?=^diff --git )/m).filter((p) => p.trim());
  if (parts.length <= 1) {
    return [{ path: "变更", body: diff }];
  }
  return parts.map((block) => {
    const m =
      block.match(/^diff --git a\/(.+?) b\/(.+)$/m) ||
      block.match(/^\+\+\+ b\/(.+)$/m) ||
      block.match(/^--- a\/(.+)$/m);
    const path = (m?.[2] || m?.[1] || "file").trim();
    return { path, body: block };
  });
}

export function DiffPreview({ serviceUrl, runId }: DiffPreviewProps) {
  const [data, setData] = useState<GitWorktreeDiffRecord | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [openPath, setOpenPath] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    const client = createRunClient(serviceUrl);
    void client
      .getWorktree(runId)
      .then((wt) => {
        if (cancelled) return;
        setData(wt);
        const files = wt.changedFiles ?? [];
        setOpenPath(files[0] ?? null);
      })
      .catch((e) => {
        if (!cancelled) {
          setData(null);
          setError(e instanceof Error ? e.message : "无法加载变更");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [serviceUrl, runId]);

  const blocks = useMemo(() => {
    if (!data?.diff) return [];
    return splitDiffByFile(data.diff);
  }, [data?.diff]);

  const files = data?.changedFiles?.length
    ? data.changedFiles
    : blocks.map((b) => b.path).filter((p) => p !== "变更");

  const activeBlock =
    blocks.find((b) => b.path === openPath || b.path.endsWith(openPath || "")) ??
    blocks[0];

  if (loading) {
    return <div className="tds-diff-empty">加载变更预览…</div>;
  }
  if (error) {
    return <div className="tds-diff-empty muted">{error}</div>;
  }
  if (!data || (!files.length && !data.diff?.trim())) {
    return <div className="tds-diff-empty muted">暂无文件变更（执行后会显示 diff 高亮）</div>;
  }

  const addCount = (data.diff.match(/^\+[^+]/gm) || []).length;
  const fileCount = files.length || blocks.length;

  return (
    <div className="tds-diff-panel">
      <div className="tds-diff-head">
        <span>
          {fileCount} 个文件改动
          {addCount > 0 ? <em className="add"> +{addCount}</em> : null}
        </span>
        <span className="tds-diff-head-right">全部收起</span>
      </div>

      <div className="tds-diff-layout">
        {files.length > 0 ? (
          <ul className="tds-diff-files">
            {files.map((f) => (
              <li key={f}>
                <button
                  type="button"
                  className={openPath === f || activeBlock?.path.endsWith(f) ? "on" : ""}
                  onClick={() => setOpenPath(f)}
                >
                  <span className="name">{f}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        <div className="tds-diff-code">
          {(activeBlock?.body || data.diff || "")
            .split("\n")
            .slice(0, 400)
            .map((line, i) => (
              <div key={i} className={`tds-diff-line ${colorizeDiffLine(line)}`}>
                <code>{line || " "}</code>
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}
