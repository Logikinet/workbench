import { useEffect, useState } from "react";
import { createProjectClient, type ProjectRecord } from "../lib/projects.js";

interface ProjectsPanelProps {
  serviceUrl: string;
  available: boolean;
  /** When bumped (e.g. after backup import), re-fetch projects so 待修复 appears immediately. */
  dataEpoch?: number;
}

const emptyDraft = { name: "", workspacePath: "", summary: "" };

export function ProjectsPanel({ serviceUrl, available, dataEpoch = 0 }: ProjectsPanelProps) {
  const client = createProjectClient(serviceUrl);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [draft, setDraft] = useState(emptyDraft);
  const [authorizationGrantId, setAuthorizationGrantId] = useState("");
  const [notice, setNotice] = useState("");

  const reload = async () => {
    if (!available) return;
    try {
      setProjects(await client.list());
      setNotice("");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法读取 Project");
    }
  };

  useEffect(() => {
    void reload();
  }, [available, dataEpoch]);

  const createProject = async (event: React.FormEvent) => {
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
      setNotice("Project 已创建并绑定主工作区。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法创建 Project");
    }
  };

  const confirmWorkspace = async () => {
    try {
      const authorization = await client.requestWorkspaceAuthorization(draft.workspacePath);
      setAuthorizationGrantId(authorization.id);
      setNotice("已在 Windows 文件夹选择器中确认主工作区；请在 10 分钟内创建 Project。");
    } catch (error) {
      setAuthorizationGrantId("");
      setNotice(error instanceof Error ? error.message : "无法确认主工作区");
    }
  };

  const updateProject = async (project: ProjectRecord, update: Partial<Pick<ProjectRecord, "name" | "status">>) => {
    try {
      const changed = await client.update(project.id, update);
      setProjects((current) => current.map((entry) => (entry.id === changed.id ? changed : entry)));
      setNotice("Project 已更新。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法更新 Project");
    }
  };

  const rename = (project: ProjectRecord) => {
    const name = window.prompt("输入新的 Project 名称", project.name);
    if (name?.trim()) void updateProject(project, { name });
  };

  return (
    <section className="workspace-panel" aria-labelledby="projects-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">PROJECTS</p>
          <h2 id="projects-title">主工作区</h2>
        </div>
        <button type="button" className="quiet-button" onClick={() => void reload()} disabled={!available}>
          刷新
        </button>
      </div>
      <form className="project-form" onSubmit={createProject}>
        <label>
          Project 名称
          <input
            required
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            placeholder="例如：个人 AI 工作台"
          />
        </label>
        <label>
          Windows 主工作区路径
          <input
            required
            value={draft.workspacePath}
            onChange={(event) => {
              setAuthorizationGrantId("");
              setDraft({ ...draft, workspacePath: event.target.value });
            }}
            placeholder="C:\\Users\\you\\Projects\\my-app"
          />
        </label>
        <label>
          项目摘要（可选）
          <input value={draft.summary} onChange={(event) => setDraft({ ...draft, summary: event.target.value })} />
        </label>
        <button type="button" className="quiet-button" onClick={() => void confirmWorkspace()} disabled={!available || !draft.workspacePath}>
          在 Windows 中选择并确认工作区
        </button>
        <button type="submit" disabled={!available || !authorizationGrantId}>
          创建 Project
        </button>
      </form>
      {notice && <p className="notice" role="status">{notice}</p>}
      <ul className="project-list">
        {projects.map((project) => (
          <li key={project.id}>
            <div>
              <strong>{project.name}</strong>
              <span>{project.workspacePath}</span>
              {project.summary && <small>{project.summary}</small>}
              {project.workspaceLinkStatus === "needs_repair" && (
                <small className="repair-note">{project.workspaceRepairNote ?? "工作区待修复：目录不存在或不可访问。"}</small>
              )}
            </div>
            <div className="project-actions">
              {project.workspaceLinkStatus === "needs_repair" && <span className="tag needs-repair">待修复</span>}
              <span className={`tag ${project.status}`}>{project.status === "active" ? "进行中" : "已归档"}</span>
              <button type="button" className="quiet-button" onClick={() => rename(project)}>重命名</button>
              <button
                type="button"
                className="quiet-button"
                onClick={() => void updateProject(project, { status: project.status === "active" ? "archived" : "active" })}
              >
                {project.status === "active" ? "归档" : "重新打开"}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
