import { useEffect, useState, type FormEvent } from "react";
import { createProjectClient, type ProjectRecord } from "../lib/projects.js";
import { FolderIcon, TdsEmpty, TdsGhostButton, TdsPage, TdsPrimaryButton } from "./TdsPage.js";

interface ProjectsPanelProps {
  serviceUrl: string;
  available: boolean;
  dataEpoch?: number;
}

const emptyDraft = { name: "", workspacePath: "", summary: "" };

export function ProjectsPanel({ serviceUrl, available, dataEpoch = 0 }: ProjectsPanelProps) {
  const client = createProjectClient(serviceUrl);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [draft, setDraft] = useState(emptyDraft);
  const [authorizationGrantId, setAuthorizationGrantId] = useState("");
  const [notice, setNotice] = useState("");
  const [showForm, setShowForm] = useState(false);

  const reload = async () => {
    if (!available) return;
    try {
      setProjects(await client.list());
      setNotice("");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法加载项目");
    }
  };

  useEffect(() => {
    void reload();
  }, [available, dataEpoch]);

  const createProject = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const created = await client.create({
        name: draft.name,
        workspacePath: draft.workspacePath,
        summary: draft.summary,
        authorizationGrantId
      });
      setProjects((current) => [created, ...current]);
      setDraft(emptyDraft);
      setAuthorizationGrantId("");
      setShowForm(false);
      setNotice("项目已创建并绑定工作区。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法创建项目");
    }
  };

  const confirmWorkspace = async () => {
    try {
      const authorization = await client.requestWorkspaceAuthorization(draft.workspacePath);
      setAuthorizationGrantId(authorization.id);
      setNotice("工作区已授权。请在 10 分钟内创建项目。");
    } catch (error) {
      setAuthorizationGrantId("");
      setNotice(error instanceof Error ? error.message : "无法授权工作区");
    }
  };

  const updateProject = async (
    project: ProjectRecord,
    update: Partial<Pick<ProjectRecord, "name" | "status">>
  ) => {
    try {
      const changed = await client.update(project.id, update);
      setProjects((current) => current.map((entry) => (entry.id === changed.id ? changed : entry)));
      setNotice("项目已更新。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法更新项目");
    }
  };

  return (
    <TdsPage
      kicker="工作"
      title="项目"
      description="项目与 Windows 主工作区"
      action={
        <TdsPrimaryButton
          disabled={!available}
          onClick={() => setShowForm((v) => !v)}
        >
          {showForm ? "关闭" : "+ 新建项目"}
        </TdsPrimaryButton>
      }
    >
      {notice ? <div className="tds-banner ok">{notice}</div> : null}

      {showForm ? (
        <form className="tds-add-panel" onSubmit={(e) => void createProject(e)}>
          <label className="tds-field">
            <span>名称</span>
            <input
              required
              value={draft.name}
              placeholder="我的项目"
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </label>
          <label className="tds-field">
            <span>工作区路径</span>
            <input
              required
              value={draft.workspacePath}
              placeholder="C:\\Users\\...\\repo"
              onChange={(e) => setDraft({ ...draft, workspacePath: e.target.value })}
            />
          </label>
          <label className="tds-field">
            <span>摘要</span>
            <input
              value={draft.summary}
              placeholder="可选"
              onChange={(e) => setDraft({ ...draft, summary: e.target.value })}
            />
          </label>
          <div className="tds-form-actions">
            <TdsGhostButton onClick={() => void confirmWorkspace()}>授权文件夹</TdsGhostButton>
            <TdsPrimaryButton type="submit" disabled={!available || !authorizationGrantId}>
              创建项目
            </TdsPrimaryButton>
          </div>
          {!authorizationGrantId ? (
            <p className="tds-muted">创建前请先授权 Windows 文件夹。</p>
          ) : (
            <p className="tds-muted">工作区已授权。</p>
          )}
        </form>
      ) : null}

      {projects.length === 0 ? (
        <TdsEmpty
          icon={<FolderIcon />}
          title="还没有项目"
          description="绑定 Windows 工作区后即可开始 Agent 工作。"
          action={
            <TdsPrimaryButton disabled={!available} onClick={() => setShowForm(true)}>
              + 新建项目
            </TdsPrimaryButton>
          }
        />
      ) : (
        <div className="tds-provider-list">
          {projects.map((project) => (
            <article key={project.id} className="tds-provider-row">
              <div className="tds-provider-main">
                <div className="tds-provider-title-row">
                  <h3>{project.name}</h3>
                  <span className={`tds-chip ${project.status === "active" ? "success" : "default"}`}>
                    {project.status}
                  </span>
                </div>
                <p className="tds-muted break-all">{project.workspacePath}</p>
                {project.summary ? <p className="tds-muted">{project.summary}</p> : null}
              </div>
              <div className="tds-provider-actions">
                <TdsGhostButton
                  onClick={() =>
                    void updateProject(project, {
                      status: project.status === "active" ? "archived" : "active"
                    })
                  }
                >
                  {project.status === "active" ? "Archive" : "Activate"}
                </TdsGhostButton>
              </div>
            </article>
          ))}
        </div>
      )}
    </TdsPage>
  );
}
