import { useEffect, useMemo, useState } from "react";
import {
  createArtifactClient,
  type ArtifactRecord,
  type BrowserEntry,
  type PreviewResult
} from "../lib/artifacts.js";

interface ArtifactBrowserPanelProps {
  serviceUrl: string;
  available: boolean;
  dataEpoch?: number;
  /** Required for filesystem browse under Project grant. */
  projectId?: string;
  /** Optional Run context for catalog filter / import. */
  runId?: string;
}

/**
 * Artifact document browser panel (Task 42).
 * Safe path browsing, multi-format preview, Office/WPS open, catalog metadata.
 * Mount when artifacts capability is wired on the service.
 */
export function ArtifactBrowserPanel({
  serviceUrl,
  available,
  dataEpoch = 0,
  projectId = "",
  runId = ""
}: ArtifactBrowserPanelProps) {
  const client = useMemo(() => createArtifactClient(serviceUrl), [serviceUrl]);

  const [projectInput, setProjectInput] = useState(projectId);
  const [runInput, setRunInput] = useState(runId);
  const [cwd, setCwd] = useState("");
  const [entries, setEntries] = useState<BrowserEntry[]>([]);
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState("");
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [catalog, setCatalog] = useState<ArtifactRecord[]>([]);
  const [selectedArtifact, setSelectedArtifact] = useState<ArtifactRecord | null>(null);
  const [officeDetail, setOfficeDetail] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");

  const activeProject = projectInput.trim();

  const reloadBrowse = async (path = cwd) => {
    if (!available || !activeProject) return;
    setBusy(true);
    try {
      const result = await client.browse(activeProject, path);
      setEntries(result.entries);
      setParentPath(result.parentPath);
      setCwd(result.path);
      setNotice(result.truncated ? `已截断，共 ${result.totalEntries} 项` : "");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "浏览失败");
    } finally {
      setBusy(false);
    }
  };

  const reloadCatalog = async () => {
    if (!available) return;
    try {
      const result = await client.list({
        projectId: activeProject || undefined,
        runId: runInput.trim() || undefined,
        q: q.trim() || undefined
      });
      setCatalog(result.artifacts);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "目录加载失败");
    }
  };

  useEffect(() => {
    setProjectInput(projectId);
  }, [projectId]);

  useEffect(() => {
    setRunInput(runId);
  }, [runId]);

  useEffect(() => {
    if (!available) return;
    void client.officeStatus().then((s) => {
      setOfficeDetail(s.detail || `Office=${s.office ? "yes" : "no"} WPS=${s.wps ? "yes" : "no"}`);
    }).catch(() => setOfficeDetail(""));
    void reloadCatalog();
    if (activeProject) void reloadBrowse("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available, serviceUrl, dataEpoch, activeProject]);

  const openEntry = async (entry: BrowserEntry) => {
    if (entry.kind === "directory") {
      setSelectedPath(entry.relativePath);
      setPreview(null);
      await reloadBrowse(entry.relativePath);
      return;
    }
    setSelectedPath(entry.relativePath);
    setBusy(true);
    try {
      const result = await client.preview(activeProject, entry.relativePath);
      setPreview(result);
      const match = catalog.find((a) => a.relativePath === entry.relativePath);
      setSelectedArtifact(match ?? null);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "预览失败");
      setPreview(null);
    } finally {
      setBusy(false);
    }
  };

  const goUp = async () => {
    if (parentPath === null) return;
    await reloadBrowse(parentPath);
    setSelectedPath("");
    setPreview(null);
  };

  const openExternal = async (preferred: "auto" | "office" | "wps" | "default" = "auto") => {
    if (!activeProject || !selectedPath) return;
    setBusy(true);
    try {
      const result = await client.openExternal(activeProject, selectedPath, preferred);
      setNotice(result.message + (result.stub ? " (stub)" : ""));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "打开失败");
    } finally {
      setBusy(false);
    }
  };

  const detectChanges = async () => {
    if (!activeProject || !selectedPath) return;
    setBusy(true);
    try {
      const result = await client.detectChanges(activeProject, selectedPath);
      setNotice(
        result.changed
          ? `检测到变化：${result.reason ?? "content changed"}`
          : `未变化：${result.reason ?? "unchanged"}`
      );
      if (result.changed && selectedArtifact) {
        await client.addVersion(selectedArtifact.id, { note: "detected after external edit" });
        await reloadCatalog();
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "检测失败");
    } finally {
      setBusy(false);
    }
  };

  const reveal = async () => {
    if (!activeProject || !selectedPath) return;
    try {
      const result = await client.reveal(activeProject, selectedPath);
      setNotice(result.message);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "定位失败");
    }
  };

  const copyPath = async () => {
    if (!activeProject || !selectedPath) return;
    try {
      const result = await client.copyPath(activeProject, selectedPath);
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(result.path);
        setNotice(`已复制路径：${result.path}`);
      } else {
        setNotice(result.path);
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "复制失败");
    }
  };

  const registerSelected = async () => {
    if (!activeProject || !selectedPath) return;
    setBusy(true);
    try {
      const record = await client.register({
        projectId: activeProject,
        relativePath: selectedPath,
        title: selectedPath.split("/").pop(),
        origin: "user",
        runId: runInput.trim() || undefined,
        tags: ["browser"]
      });
      setSelectedArtifact(record);
      setNotice(`已登记 Artifact ${record.id.slice(0, 8)}`);
      await reloadCatalog();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "登记失败");
    } finally {
      setBusy(false);
    }
  };

  const importRun = async () => {
    if (!activeProject || !runInput.trim()) return;
    setBusy(true);
    try {
      const result = await client.importRun(runInput.trim(), activeProject);
      setNotice(`已导入 ${result.artifacts.length} 个 Run Artifact`);
      await reloadCatalog();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "导入失败");
    } finally {
      setBusy(false);
    }
  };

  if (!available) {
    return (
      <section className="workspace-panel artifact-browser-panel">
        <div className="section-heading">
          <h2>Artifact 文档浏览器</h2>
        </div>
        <p className="muted">服务未提供 artifacts 能力，或尚未挂载路由。</p>
      </section>
    );
  }

  return (
    <section className="workspace-panel artifact-browser-panel">
      <div className="section-heading">
        <h2>Artifact 文档浏览器</h2>
        <button type="button" className="quiet-button" disabled={busy} onClick={() => void reloadBrowse()}>
          刷新
        </button>
      </div>
      <p className="muted">
        安全浏览 Project 授权目录 · 本地文件为真源 · 预览不改写格式
        {officeDetail ? ` · ${officeDetail}` : ""}
      </p>

      <div className="artifact-toolbar">
        <label>
          Project ID
          <input value={projectInput} onChange={(e) => setProjectInput(e.target.value)} placeholder="project id" />
        </label>
        <label>
          Run ID
          <input value={runInput} onChange={(e) => setRunInput(e.target.value)} placeholder="optional run" />
        </label>
        <label>
          搜索目录
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="title / path" />
        </label>
        <button type="button" className="quiet-button" disabled={busy} onClick={() => void reloadCatalog()}>
          筛选目录
        </button>
        <button type="button" className="quiet-button" disabled={busy || !runInput.trim()} onClick={() => void importRun()}>
          导入 Run
        </button>
      </div>

      {notice && <p className="notice">{notice}</p>}

      <div className="artifact-layout">
        <div className="artifact-tree">
          <div className="artifact-path-bar">
            <strong>/{cwd || ""}</strong>
            <button type="button" className="quiet-button" disabled={parentPath === null || busy} onClick={() => void goUp()}>
              上级
            </button>
          </div>
          <ul className="artifact-entry-list">
            {entries.map((entry) => (
              <li key={entry.relativePath}>
                <button
                  type="button"
                  className={selectedPath === entry.relativePath ? "active" : ""}
                  onClick={() => void openEntry(entry)}
                >
                  <span className="tag">{entry.kind === "directory" ? "dir" : entry.previewKind}</span>
                  <strong>{entry.name}</strong>
                  {entry.kind === "file" && (
                    <small>
                      {formatBytes(entry.sizeBytes)}
                      {entry.large ? " · large" : ""}
                    </small>
                  )}
                </button>
              </li>
            ))}
            {entries.length === 0 && <li className="muted">空目录或未加载</li>}
          </ul>
        </div>

        <div className="artifact-preview">
          <div className="artifact-preview-actions">
            <button type="button" disabled={!selectedPath || busy} onClick={() => void openExternal("auto")}>
              外部打开
            </button>
            <button type="button" className="quiet-button" disabled={!selectedPath || busy} onClick={() => void openExternal("office")}>
              Office
            </button>
            <button type="button" className="quiet-button" disabled={!selectedPath || busy} onClick={() => void openExternal("wps")}>
              WPS
            </button>
            <button type="button" className="quiet-button" disabled={!selectedPath || busy} onClick={() => void detectChanges()}>
              检测变化
            </button>
            <button type="button" className="quiet-button" disabled={!selectedPath || busy} onClick={() => void reveal()}>
              资源管理器
            </button>
            <button type="button" className="quiet-button" disabled={!selectedPath || busy} onClick={() => void copyPath()}>
              复制路径
            </button>
            <button type="button" className="quiet-button" disabled={!selectedPath || busy} onClick={() => void registerSelected()}>
              登记 Artifact
            </button>
          </div>

          {!preview && <p className="muted">选择文件以预览 Markdown / 代码 / 图片 / PDF / Office 只读提取。</p>}

          {preview && (
            <div className="artifact-preview-body">
              <header>
                <strong>{preview.relativePath}</strong>
                <span className="tag">{preview.previewKind}</span>
                {preview.truncated && <span className="tag">truncated</span>}
                {!preview.ok && <span className="tag danger-label">preview error</span>}
              </header>
              {preview.error && <p className="muted">{preview.error}</p>}
              {preview.parts && preview.parts.length > 0 && (
                <p className="muted">Parts: {preview.parts.join(", ")}</p>
              )}
              {preview.pageCount !== undefined && <p className="muted">Pages ≈ {preview.pageCount}</p>}

              {preview.previewKind === "image" && preview.base64 && (
                <img
                  className="artifact-image"
                  alt={preview.relativePath}
                  src={`data:${preview.mimeType};base64,${preview.base64}`}
                />
              )}
              {preview.previewKind === "pdf" && preview.base64 && (
                <iframe
                  className="artifact-pdf"
                  title={preview.relativePath}
                  src={`data:application/pdf;base64,${preview.base64}`}
                />
              )}
              {(preview.previewKind === "docx" ||
                preview.previewKind === "xlsx" ||
                preview.previewKind === "pptx") &&
                preview.html && (
                  <div
                    className="artifact-office-html"
                    dangerouslySetInnerHTML={{ __html: preview.html }}
                  />
                )}
              {preview.text &&
                preview.previewKind !== "docx" &&
                preview.previewKind !== "xlsx" &&
                preview.previewKind !== "pptx" && (
                  <pre className={preview.previewKind === "markdown" ? "artifact-md" : "artifact-code"}>
                    {preview.text}
                  </pre>
                )}
              {(preview.previewKind === "docx" ||
                preview.previewKind === "xlsx" ||
                preview.previewKind === "pptx") &&
                !preview.html &&
                preview.text && <pre className="artifact-code">{preview.text}</pre>}
            </div>
          )}

          {selectedArtifact && (
            <aside className="artifact-meta">
              <h4>Artifact 元数据</h4>
              <dl>
                <div>
                  <dt>标题</dt>
                  <dd>{selectedArtifact.title}</dd>
                </div>
                <div>
                  <dt>版本</dt>
                  <dd>v{selectedArtifact.currentVersion}</dd>
                </div>
                <div>
                  <dt>生成者</dt>
                  <dd>{selectedArtifact.createdBy ?? "—"}</dd>
                </div>
                <div>
                  <dt>Run</dt>
                  <dd>{selectedArtifact.runId ?? "—"}</dd>
                </div>
                <div>
                  <dt>审查</dt>
                  <dd>
                    {selectedArtifact.reviewStatus}
                    {selectedArtifact.reviewSummary ? ` · ${selectedArtifact.reviewSummary}` : ""}
                  </dd>
                </div>
              </dl>
              {selectedArtifact.evidenceLinks.length > 0 && (
                <>
                  <h5>Evidence</h5>
                  <ul>
                    {selectedArtifact.evidenceLinks.map((link) => (
                      <li key={link.id}>
                        {link.summary}
                        {link.path ? ` · ${link.path}` : ""}
                        {link.sourceUrl ? ` · ${link.sourceUrl}` : ""}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {selectedArtifact.diffLinks.length > 0 && (
                <>
                  <h5>Diff</h5>
                  <ul>
                    {selectedArtifact.diffLinks.map((link, idx) => (
                      <li key={`${link.path}-${idx}`}>
                        {link.kind}: {link.path}
                        {link.runId ? ` (run ${link.runId})` : ""}
                        {link.summary ? ` — ${link.summary}` : ""}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {selectedArtifact.sourceLinks.length > 0 && (
                <>
                  <h5>来源</h5>
                  <ul>
                    {selectedArtifact.sourceLinks.map((link, idx) => (
                      <li key={`${link.label}-${idx}`}>
                        {link.label}
                        {link.path ? ` · ${link.path}` : ""}
                        {link.url ? ` · ${link.url}` : ""}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <h5>版本历史</h5>
              <ol className="artifact-versions">
                {selectedArtifact.versions
                  .slice()
                  .reverse()
                  .map((v) => (
                    <li key={v.id}>
                      v{v.version} · {v.createdAt}
                      {v.note ? ` · ${v.note}` : ""}
                      <small> {v.contentHash.slice(0, 12)}</small>
                    </li>
                  ))}
              </ol>
            </aside>
          )}
        </div>

        <div className="artifact-catalog">
          <h4>Artifact 索引</h4>
          <ul className="artifact-catalog-list">
            {catalog.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedArtifact(item);
                    setSelectedPath(item.relativePath);
                    if (activeProject) void client.preview(activeProject, item.relativePath).then(setPreview);
                  }}
                >
                  <strong>{item.title}</strong>
                  <span>
                    {item.relativePath} · v{item.currentVersion} · {item.reviewStatus}
                  </span>
                  <small>
                    {item.origin}
                    {item.runId ? ` · run ${item.runId}` : ""}
                  </small>
                </button>
              </li>
            ))}
            {catalog.length === 0 && <li className="muted">暂无登记项</li>}
          </ul>
        </div>
      </div>
    </section>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
