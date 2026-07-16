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
import {
  EmptyHint,
  Field,
  Grid2,
  ListCard,
  Notice,
  Panel,
  PrimaryButton,
  QuietButton,
  RowActions,
  SelectField,
  Stack,
  Tag,
  TextAreaField,
  TextInput
} from "./ui.js";

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
    <Panel
      eyebrow="DOCUMENT WORKFLOW"
      title="报告 / 论文流水线（Zotero + OfficeCLI）"
      description="提纲批准 → 真实文献证据 → 分章撰写 → OfficeCLI DOCX → 审查 → Word/Zotero 终排版"
      actions={
        <QuietButton isDisabled={!available || busy} onPress={() => void refresh()}>
          刷新
        </QuietButton>
      }
    >
      <RowActions>
        <Tag color={zotero?.running ? "success" : "warning"}>
          Zotero：{zotero?.running ? "在线" : zotero?.detail ?? "未知"}
        </Tag>
        <Tag color={office?.installed ? "success" : "warning"}>
          OfficeCLI：{office?.installed ? `已安装 ${office.version ?? ""}` : office?.detail ?? "未知"}
        </Tag>
      </RowActions>

      {!available && <Notice tone="warning">服务离线时无法使用文档工作流。</Notice>}
      {notice ? <Notice>{notice}</Notice> : null}

      <Grid2>
        <Field label="文档类型">
          <SelectField
            aria-label="文档类型"
            value={documentType}
            onChange={(event) => setDocumentType(event.target.value as DocumentType)}
          >
            {Object.entries(documentTypeLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </SelectField>
        </Field>
        <Field label="引用模式">
          <SelectField
            aria-label="引用模式"
            value={citationMode}
            onChange={(event) => setCitationMode(event.target.value as CitationMode)}
          >
            <option value="dynamic_zotero">动态引用（Word + Zotero 插件）</option>
            <option value="static">静态引用</option>
          </SelectField>
        </Field>
        <Field label="题目">
          <TextInput aria-label="题目" value={title} onChange={(event) => setTitle(event.target.value)} />
        </Field>
        <Field label="工作区路径">
          <TextInput
            aria-label="工作区路径"
            placeholder="C:\\path\\to\\project"
            value={workspaceRoot}
            onChange={(event) => setWorkspaceRoot(event.target.value)}
          />
        </Field>
        <Field label="Zotero Collection">
          <SelectField
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
          </SelectField>
        </Field>
      </Grid2>

      <Field label="任务要求">
        <TextAreaField
          aria-label="任务要求"
          rows={3}
          value={brief}
          onChange={(event) => setBrief(event.target.value)}
        />
      </Field>

      <RowActions>
        <PrimaryButton isDisabled={!available || busy} onPress={() => void createJob()}>
          创建文档任务
        </PrimaryButton>
      </RowActions>

      {jobs.length > 0 && (
        <Field label="当前任务">
          <SelectField
            aria-label="当前任务"
            value={selected?.jobId ?? ""}
            onChange={(event) => setSelectedId(event.target.value)}
          >
            {jobs.map((job) => (
              <option key={job.jobId} value={job.jobId}>
                {job.requirement.title} · {job.status}
              </option>
            ))}
          </SelectField>
        </Field>
      )}

      {selected && (
        <Stack>
          <ListCard>
            <p className="m-0 text-sm">
              <strong>状态：</strong>
              {selected.status}
              {selected.requirement.citationMode === "dynamic_zotero" ? " · 动态引用" : " · 静态引用"}
              {selected.dynamicCitationsPresent ? " · 已含动态字段保护" : ""}
            </p>
          </ListCard>

          <RowActions>
            <QuietButton
              isDisabled={busy}
              onPress={() => void runStep("收集文献", () => client.gatherSources(selected.jobId))}
            >
              1. 收集 Zotero 文献
            </QuietButton>
            <QuietButton
              isDisabled={busy}
              onPress={() => void runStep("生成提纲", () => client.generateOutline(selected.jobId))}
            >
              2. 生成提纲
            </QuietButton>
            <QuietButton
              isDisabled={busy}
              onPress={() => void runStep("批准提纲", () => client.approveOutline(selected.jobId))}
            >
              3. 批准提纲
            </QuietButton>
            <QuietButton
              isDisabled={busy}
              onPress={() => void runStep("分章写作", () => client.writeSections(selected.jobId))}
            >
              4. 分章写作
            </QuietButton>
            <QuietButton
              isDisabled={busy}
              onPress={() => void runStep("生成 DOCX", () => client.generateDocx(selected.jobId))}
            >
              5. OfficeCLI 生成 DOCX
            </QuietButton>
            <QuietButton
              isDisabled={busy}
              onPress={() => void runStep("审查", () => client.runReviews(selected.jobId))}
            >
              6. /no-mistakes 审查
            </QuietButton>
            <QuietButton
              isDisabled={busy}
              onPress={() => void runStep("引用定稿", () => client.finalizeCitations(selected.jobId))}
            >
              7. 引用定稿
            </QuietButton>
            <QuietButton
              isDisabled={busy}
              onPress={() => void runStep("导出", () => client.exportFinal(selected.jobId))}
            >
              8. 导出清单与报告
            </QuietButton>
            <QuietButton
              isDisabled={busy}
              onPress={() =>
                void runStep("Word 交接", async () => {
                  const hint = await client.openWord(selected.jobId);
                  setNotice(hint.message);
                  return selected;
                })
              }
            >
              Word 打开提示
            </QuietButton>
            <QuietButton
              isDisabled={busy}
              onPress={() =>
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
            </QuietButton>
          </RowActions>

          <Grid2>
            <Stack>
              <h4 className="m-0 text-sm font-semibold">章节</h4>
              {selected.sections.length === 0 ? (
                <EmptyHint>暂无章节</EmptyHint>
              ) : (
                <ul className="m-0 list-none space-y-1 p-0 text-sm">
                  {selected.sections.map((section) => (
                    <li key={section.id}>
                      {section.order}. {section.title} · {section.status}
                    </li>
                  ))}
                </ul>
              )}
            </Stack>
            <Stack>
              <h4 className="m-0 text-sm font-semibold">文献 / 证据</h4>
              {selected.sources.length === 0 ? (
                <EmptyHint>暂无文献</EmptyHint>
              ) : (
                <ul className="m-0 list-none space-y-1 p-0 text-sm">
                  {selected.sources.map((source) => (
                    <li key={source.itemKey}>
                      <code>{source.itemKey}</code> {source.title}
                    </li>
                  ))}
                </ul>
              )}
              <h4 className="m-0 text-sm font-semibold">引用映射</h4>
              {selected.citationMap.entries.length === 0 ? (
                <EmptyHint>暂无引用映射</EmptyHint>
              ) : (
                <ul className="m-0 list-none space-y-1 p-0 text-sm">
                  {selected.citationMap.entries.map((entry) => (
                    <li key={entry.claimId}>
                      {entry.claim} → {entry.sourceItems.join(", ")}
                    </li>
                  ))}
                </ul>
              )}
            </Stack>
          </Grid2>

          {selected.currentDocxPath && (
            <EmptyHint>
              DOCX：<code>{selected.currentDocxPath}</code>
            </EmptyHint>
          )}
          {selected.reviews[0] && (
            <p className="m-0 text-sm">
              最近审查：{selected.reviews[selected.reviews.length - 1]?.summary}
            </p>
          )}
        </Stack>
      )}
    </Panel>
  );
}
