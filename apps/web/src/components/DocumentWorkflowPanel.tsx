import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createDocumentWorkflowClient,
  type CitationMode,
  type DocumentJobRecord,
  type DocumentType,
  type OfficeCliStatusRecord,
  type ZoteroCollectionRecord,
  type ZoteroStatusRecord
} from "../lib/documentWorkflow.js";

interface DocumentWorkflowPanelProps {
  serviceUrl: string;
  available: boolean;
}

const documentTypeLabels: Record<DocumentType, string> = {
  course_report: "课程报告",
  academic_paper: "学术论文",
  business_plan: "商业计划书",
  research_report: "调研报告",
  lab_report: "实验报告",
  custom: "自定义"
};

export function DocumentWorkflowPanel({ serviceUrl, available }: DocumentWorkflowPanelProps) {
  const client = useMemo(() => createDocumentWorkflowClient(serviceUrl), [serviceUrl]);
  const [jobs, setJobs] = useState<DocumentJobRecord[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [zotero, setZotero] = useState<ZoteroStatusRecord | null>(null);
  const [office, setOffice] = useState<OfficeCliStatusRecord | null>(null);
  const [collections, setCollections] = useState<ZoteroCollectionRecord[]>([]);

  const [title, setTitle] = useState("Agent Harness 课程报告");
  const [brief, setBrief] = useState("根据任务要求撰写报告，禁止虚构文献与实验数据。");
  const [documentType, setDocumentType] = useState<DocumentType>("course_report");
  const [citationMode, setCitationMode] = useState<CitationMode>("dynamic_zotero");
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [collectionKey, setCollectionKey] = useState("");

  const selected = jobs.find((job) => job.jobId === selectedId) ?? jobs[0];

  const refresh = useCallback(async () => {
    if (!available) return;
    try {
      const [list, zStatus, oStatus] = await Promise.all([
        client.listJobs(),
        client.zoteroStatus().catch(() => null),
        client.officeStatus().catch(() => null)
      ]);
      setJobs(list);
      setZotero(zStatus);
      setOffice(oStatus);
      if (zStatus?.running) {
        const cols = await client.zoteroCollections().catch(() => []);
        setCollections(cols);
      }
      if (!selectedId && list[0]) setSelectedId(list[0].jobId);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法加载文档工作流");
    }
  }, [available, client, selectedId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runStep = async (label: string, action: () => Promise<DocumentJobRecord | unknown>) => {
    setBusy(true);
    try {
      const result = await action();
      if (result && typeof result === "object" && "jobId" in result) {
        const job = result as DocumentJobRecord;
        setSelectedId(job.jobId);
      }
      if (result && typeof result === "object" && "job" in result) {
        const exported = result as { job: DocumentJobRecord; citationListPath: string };
        setSelectedId(exported.job.jobId);
        setNotice(`${label}完成：${exported.citationListPath}`);
      } else {
        setNotice(`${label}完成`);
      }
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : `${label}失败`);
    } finally {
      setBusy(false);
    }
  };

  const createJob = async () => {
    if (!workspaceRoot.trim()) {
      setNotice("请填写 Project 工作区绝对路径（workspaceRoot）");
      return;
    }
    await runStep("创建任务", () =>
      client.createJob({
        workspaceRoot: workspaceRoot.trim(),
        requirement: {
          title: title.trim(),
          documentType,
          assignmentBrief: brief.trim(),
          citationMode,
          bibliographyStyle: "apa",
          zoteroCollectionKey: collectionKey || undefined,
          mustNotInvent: ["参考文献", "实验数据"]
        }
      })
    );
  };

  return (
    <section className="panel document-workflow-panel" aria-label="文档工作流">
      <header>
        <p className="eyebrow">DOCUMENT WORKFLOW</p>
        <h3>报告 / 论文流水线（Zotero + OfficeCLI）</h3>
        <p className="muted">
          提纲批准 → 真实文献证据 → 分章撰写 → OfficeCLI DOCX → 审查 → Word/Zotero 终排版
        </p>
      </header>

      <div className="status-row">
        <span className={zotero?.running ? "chip ok" : "chip warn"}>
          Zotero：{zotero?.running ? "在线" : zotero?.detail ?? "未知"}
        </span>
        <span className={office?.installed ? "chip ok" : "chip warn"}>
          OfficeCLI：{office?.installed ? `已安装 ${office.version ?? ""}` : office?.detail ?? "未知"}
        </span>
      </div>

      {!available && <p className="notice">服务离线时无法使用文档工作流。</p>}
      {notice && <p className="notice" role="status">{notice}</p>}

      <div className="form-grid">
        <label>
          文档类型
          <select
            aria-label="文档类型"
            value={documentType}
            onChange={(event) => setDocumentType(event.target.value as DocumentType)}
          >
            {Object.entries(documentTypeLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          引用模式
          <select
            aria-label="引用模式"
            value={citationMode}
            onChange={(event) => setCitationMode(event.target.value as CitationMode)}
          >
            <option value="dynamic_zotero">动态引用（Word + Zotero 插件）</option>
            <option value="static">静态引用</option>
          </select>
        </label>
        <label>
          题目
          <input aria-label="题目" value={title} onChange={(event) => setTitle(event.target.value)} />
        </label>
        <label>
          工作区路径
          <input
            aria-label="工作区路径"
            placeholder="C:\\path\\to\\project"
            value={workspaceRoot}
            onChange={(event) => setWorkspaceRoot(event.target.value)}
          />
        </label>
        <label>
          Zotero Collection
          <select
            aria-label="Zotero Collection"
            value={collectionKey}
            onChange={(event) => setCollectionKey(event.target.value)}
          >
            <option value="">（全部 / 稍后指定）</option>
            {collections.map((col) => (
              <option key={col.key} value={col.key}>
                {col.name}
              </option>
            ))}
          </select>
        </label>
        <label className="full">
          任务要求
          <textarea aria-label="任务要求" rows={3} value={brief} onChange={(event) => setBrief(event.target.value)} />
        </label>
      </div>

      <div className="button-row">
        <button type="button" disabled={!available || busy} onClick={() => void createJob()}>
          创建文档任务
        </button>
        <button type="button" className="quiet-button" disabled={!available || busy} onClick={() => void refresh()}>
          刷新
        </button>
      </div>

      {jobs.length > 0 && (
        <label>
          当前任务
          <select
            aria-label="当前任务"
            value={selected?.jobId ?? ""}
            onChange={(event) => setSelectedId(event.target.value)}
          >
            {jobs.map((job) => (
              <option key={job.jobId} value={job.jobId}>
                {job.requirement.title} · {job.status}
              </option>
            ))}
          </select>
        </label>
      )}

      {selected && (
        <div className="document-job-detail">
          <p>
            <strong>状态：</strong>
            {selected.status}
            {selected.requirement.citationMode === "dynamic_zotero" ? " · 动态引用" : " · 静态引用"}
            {selected.dynamicCitationsPresent ? " · 已含动态字段保护" : ""}
          </p>

          <div className="button-row wrap">
            <button type="button" disabled={busy} onClick={() => void runStep("收集文献", () => client.gatherSources(selected.jobId))}>
              1. 收集 Zotero 文献
            </button>
            <button type="button" disabled={busy} onClick={() => void runStep("生成提纲", () => client.generateOutline(selected.jobId))}>
              2. 生成提纲
            </button>
            <button type="button" disabled={busy} onClick={() => void runStep("批准提纲", () => client.approveOutline(selected.jobId))}>
              3. 批准提纲
            </button>
            <button type="button" disabled={busy} onClick={() => void runStep("分章写作", () => client.writeSections(selected.jobId))}>
              4. 分章写作
            </button>
            <button type="button" disabled={busy} onClick={() => void runStep("生成 DOCX", () => client.generateDocx(selected.jobId))}>
              5. OfficeCLI 生成 DOCX
            </button>
            <button type="button" disabled={busy} onClick={() => void runStep("审查", () => client.runReviews(selected.jobId))}>
              6. /no-mistakes 审查
            </button>
            <button type="button" disabled={busy} onClick={() => void runStep("引用定稿", () => client.finalizeCitations(selected.jobId))}>
              7. 引用定稿
            </button>
            <button type="button" disabled={busy} onClick={() => void runStep("导出", () => client.exportFinal(selected.jobId))}>
              8. 导出清单与报告
            </button>
            <button
              type="button"
              className="quiet-button"
              disabled={busy}
              onClick={() =>
                void runStep("Word 交接", async () => {
                  const hint = await client.openWord(selected.jobId);
                  setNotice(hint.message);
                  return selected;
                })
              }
            >
              Word 打开提示
            </button>
            <button
              type="button"
              className="quiet-button"
              disabled={busy}
              onClick={() =>
                void runStep("检测变更", async () => {
                  const change = await client.fileChange(selected.jobId);
                  setNotice(change.changed ? "检测到 Word 保存变更" : "文件未变化");
                  if (change.changed) {
                    return client.registerManualVersion(selected.jobId, "用户在 Word 中保存");
                  }
                  return selected;
                })
              }
            >
              刷新文件状态
            </button>
          </div>

          <div className="two-col">
            <div>
              <h4>章节</h4>
              <ul>
                {selected.sections.map((section) => (
                  <li key={section.id}>
                    {section.order}. {section.title} · {section.status}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h4>文献 / 证据</h4>
              <ul>
                {selected.sources.map((source) => (
                  <li key={source.itemKey}>
                    <code>{source.itemKey}</code> {source.title}
                  </li>
                ))}
              </ul>
              <h4>引用映射</h4>
              <ul>
                {selected.citationMap.entries.map((entry) => (
                  <li key={entry.claimId}>
                    {entry.claim} → {entry.sourceItems.join(", ")}
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {selected.currentDocxPath && (
            <p className="muted">
              DOCX：<code>{selected.currentDocxPath}</code>
            </p>
          )}
          {selected.reviews[0] && (
            <p>
              最近审查：{selected.reviews[selected.reviews.length - 1]?.summary}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
