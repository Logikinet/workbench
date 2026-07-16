import { useEffect, useMemo, useState } from "react";
import {
  createArtifactClient,
  type ArtifactRecord,
  type BrowserEntry,
  type PreviewResult
} from "../lib/artifacts.js";
import {
  EmptyHint,
  Field,
  ListCard,
  Notice,
  Panel,
  PrimaryButton,
  QuietButton,
  RowActions,
  Stack,
  Tag,
  TextInput
} from "./ui.js";

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
    void client
      .officeStatus()
      .then((s) => {
        setOfficeDetail(s.detail || `Office=${s.office ? "yes" : "no"} WPS=${s.wps ? "yes" : "no"}`);
      })
      .catch(() => setOfficeDetail(""));
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
      <Panel title="Artifact 文档浏览器">
        <EmptyHint>服务未提供 artifacts 能力，或尚未挂载路由。</EmptyHint>
      </Panel>
    );
  }

  return (
    <Panel
      eyebrow="ARTIFACTS"
      title="Artifact 文档浏览器"
      description={`安全浏览 Project 授权目录 · 本地文件为真源 · 预览不改写格式${officeDetail ? ` · ${officeDetail}` : ""}`}
      actions={
        <QuietButton isDisabled={busy} onPress={() => void reloadBrowse()}>
          刷新
        </QuietButton>
      }
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Project ID">
          <TextInput
            value={projectInput}
            onChange={(e) => setProjectInput(e.target.value)}
            placeholder="project id"
          />
        </Field>
        <Field label="Run ID">
          <TextInput
            value={runInput}
            onChange={(e) => setRunInput(e.target.value)}
            placeholder="optional run"
          />
        </Field>
        <Field label="搜索目录">
          <TextInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="title / path" />
        </Field>
      </div>

      <RowActions>
        <QuietButton isDisabled={busy} onPress={() => void reloadCatalog()}>
          筛选目录
        </QuietButton>
        <QuietButton isDisabled={busy || !runInput.trim()} onPress={() => void importRun()}>
          导入 Run
        </QuietButton>
      </RowActions>

      <Notice>{notice}</Notice>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,1fr)]">
        <Stack>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <strong className="text-sm">/{cwd || ""}</strong>
            <QuietButton isDisabled={parentPath === null || busy} onPress={() => void goUp()}>
              上级
            </QuietButton>
          </div>
          {entries.map((entry) => (
            <ListCard
              key={entry.relativePath}
              className={selectedPath === entry.relativePath ? "ring-2 ring-accent" : ""}
              actions={
                <QuietButton onPress={() => void openEntry(entry)}>打开</QuietButton>
              }
            >
              <div className="flex flex-wrap items-center gap-2">
                <Tag>{entry.kind === "directory" ? "dir" : entry.previewKind}</Tag>
                <strong className="text-sm">{entry.name}</strong>
              </div>
              {entry.kind === "file" ? (
                <EmptyHint>
                  {formatBytes(entry.sizeBytes)}
                  {entry.large ? " · large" : ""}
                </EmptyHint>
              ) : null}
            </ListCard>
          ))}
          {entries.length === 0 ? <EmptyHint>空目录或未加载</EmptyHint> : null}
        </Stack>

        <Stack>
          <RowActions>
            <PrimaryButton isDisabled={!selectedPath || busy} onPress={() => void openExternal("auto")}>
              外部打开
            </PrimaryButton>
            <QuietButton isDisabled={!selectedPath || busy} onPress={() => void openExternal("office")}>
              Office
            </QuietButton>
            <QuietButton isDisabled={!selectedPath || busy} onPress={() => void openExternal("wps")}>
              WPS
            </QuietButton>
            <QuietButton isDisabled={!selectedPath || busy} onPress={() => void detectChanges()}>
              检测变化
            </QuietButton>
            <QuietButton isDisabled={!selectedPath || busy} onPress={() => void reveal()}>
              资源管理器
            </QuietButton>
            <QuietButton isDisabled={!selectedPath || busy} onPress={() => void copyPath()}>
              复制路径
            </QuietButton>
            <QuietButton isDisabled={!selectedPath || busy} onPress={() => void registerSelected()}>
              登记 Artifact
            </QuietButton>
          </RowActions>

          {!preview ? (
            <EmptyHint>选择文件以预览 Markdown / 代码 / 图片 / PDF / Office 只读提取。</EmptyHint>
          ) : null}

          {preview ? (
            <Stack className="rounded-xl border border-border p-4">
              <div className="flex flex-wrap items-center gap-2">
                <strong className="text-sm">{preview.relativePath}</strong>
                <Tag>{preview.previewKind}</Tag>
                {preview.truncated ? <Tag color="warning">truncated</Tag> : null}
                {!preview.ok ? <Tag color="danger">preview error</Tag> : null}
              </div>
              {preview.error ? <EmptyHint>{preview.error}</EmptyHint> : null}
              {preview.parts && preview.parts.length > 0 ? (
                <EmptyHint>Parts: {preview.parts.join(", ")}</EmptyHint>
              ) : null}
              {preview.pageCount !== undefined ? (
                <EmptyHint>Pages ≈ {preview.pageCount}</EmptyHint>
              ) : null}

              {preview.previewKind === "image" && preview.base64 ? (
                <img
                  className="max-h-96 max-w-full rounded-lg border border-border"
                  alt={preview.relativePath}
                  src={`data:${preview.mimeType};base64,${preview.base64}`}
                />
              ) : null}
              {preview.previewKind === "pdf" && preview.base64 ? (
                <iframe
                  className="h-96 w-full rounded-lg border border-border"
                  title={preview.relativePath}
                  src={`data:application/pdf;base64,${preview.base64}`}
                />
              ) : null}
              {(preview.previewKind === "docx" ||
                preview.previewKind === "xlsx" ||
                preview.previewKind === "pptx") &&
              preview.html ? (
                <div
                  className="max-h-96 overflow-auto rounded-lg border border-border bg-field p-3 text-sm"
                  dangerouslySetInnerHTML={{ __html: preview.html }}
                />
              ) : null}
              {preview.text &&
              preview.previewKind !== "docx" &&
              preview.previewKind !== "xlsx" &&
              preview.previewKind !== "pptx" ? (
                <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-lg bg-field p-3 text-sm">
                  {preview.text}
                </pre>
              ) : null}
              {(preview.previewKind === "docx" ||
                preview.previewKind === "xlsx" ||
                preview.previewKind === "pptx") &&
              !preview.html &&
              preview.text ? (
                <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-lg bg-field p-3 text-sm">
                  {preview.text}
                </pre>
              ) : null}
            </Stack>
          ) : null}

          {selectedArtifact ? (
            <Stack className="rounded-xl border border-border p-4">
              <strong>Artifact 元数据</strong>
              <EmptyHint>标题：{selectedArtifact.title}</EmptyHint>
              <EmptyHint>版本：v{selectedArtifact.currentVersion}</EmptyHint>
              <EmptyHint>生成者：{selectedArtifact.createdBy ?? "—"}</EmptyHint>
              <EmptyHint>Run：{selectedArtifact.runId ?? "—"}</EmptyHint>
              <EmptyHint>
                审查：{selectedArtifact.reviewStatus}
                {selectedArtifact.reviewSummary ? ` · ${selectedArtifact.reviewSummary}` : ""}
              </EmptyHint>
              {selectedArtifact.evidenceLinks.length > 0 ? (
                <>
                  <strong className="text-sm">Evidence</strong>
                  <ul className="m-0 list-disc space-y-1 pl-5 text-sm">
                    {selectedArtifact.evidenceLinks.map((link) => (
                      <li key={link.id}>
                        {link.summary}
                        {link.path ? ` · ${link.path}` : ""}
                        {link.sourceUrl ? ` · ${link.sourceUrl}` : ""}
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
              {selectedArtifact.diffLinks.length > 0 ? (
                <>
                  <strong className="text-sm">Diff</strong>
                  <ul className="m-0 list-disc space-y-1 pl-5 text-sm">
                    {selectedArtifact.diffLinks.map((link, idx) => (
                      <li key={`${link.path}-${idx}`}>
                        {link.kind}: {link.path}
                        {link.runId ? ` (run ${link.runId})` : ""}
                        {link.summary ? ` — ${link.summary}` : ""}
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
              {selectedArtifact.sourceLinks.length > 0 ? (
                <>
                  <strong className="text-sm">来源</strong>
                  <ul className="m-0 list-disc space-y-1 pl-5 text-sm">
                    {selectedArtifact.sourceLinks.map((link, idx) => (
                      <li key={`${link.label}-${idx}`}>
                        {link.label}
                        {link.path ? ` · ${link.path}` : ""}
                        {link.url ? ` · ${link.url}` : ""}
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
              <strong className="text-sm">版本历史</strong>
              <Stack>
                {selectedArtifact.versions
                  .slice()
                  .reverse()
                  .map((v) => (
                    <ListCard key={v.id}>
                      <span className="text-sm">
                        v{v.version} · {v.createdAt}
                        {v.note ? ` · ${v.note}` : ""}
                      </span>
                      <EmptyHint>{v.contentHash.slice(0, 12)}</EmptyHint>
                    </ListCard>
                  ))}
              </Stack>
            </Stack>
          ) : null}
        </Stack>

        <Stack>
          <strong>Artifact 索引</strong>
          {catalog.map((item) => (
            <ListCard
              key={item.id}
              actions={
                <QuietButton
                  onPress={() => {
                    setSelectedArtifact(item);
                    setSelectedPath(item.relativePath);
                    if (activeProject) void client.preview(activeProject, item.relativePath).then(setPreview);
                  }}
                >
                  预览
                </QuietButton>
              }
            >
              <strong className="text-sm">{item.title}</strong>
              <EmptyHint>
                {item.relativePath} · v{item.currentVersion} · {item.reviewStatus}
              </EmptyHint>
              <EmptyHint>
                {item.origin}
                {item.runId ? ` · run ${item.runId}` : ""}
              </EmptyHint>
            </ListCard>
          ))}
          {catalog.length === 0 ? <EmptyHint>暂无登记项</EmptyHint> : null}
        </Stack>
      </div>
    </Panel>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
