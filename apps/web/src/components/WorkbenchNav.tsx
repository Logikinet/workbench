/**
 * todos.dev sidebar — structure from user screenshots:
 * Brand | icon row (team, inbox) | 总管 | 新建 | 项目 | 资源 | footer machine + user
 * Fixed: no smashed text, full-width stack, Chinese labels only.
 */

import { useEffect, useState, type ReactNode } from "react";
import {
  formatWorkbenchHash,
  isNavSectionActive,
  type WorkbenchRoute,
  type WorkbenchSection
} from "../lib/workbenchRoutes.js";
import { createProjectClient, type ProjectRecord } from "../lib/projects.js";

interface WorkbenchNavProps {
  route: WorkbenchRoute;
  waitingCount?: number;
  statusKind?: "online" | "offline" | "error";
  statusLabel?: string;
  serviceUrl?: string;
  onNavigate(route: WorkbenchRoute): void;
  /** 侧栏「+ 新建」= 新建项目（不是任务） */
  onNewProject?(): void;
}

function Sq({ children, accent }: { children: ReactNode; accent?: boolean }) {
  return (
    <span className={`tds-sq${accent ? " accent" : ""}`} aria-hidden="true">
      {children}
    </span>
  );
}

export function WorkbenchNav({
  route,
  waitingCount = 0,
  statusKind = "offline",
  statusLabel = "离线",
  serviceUrl = "http://127.0.0.1:41731",
  onNavigate,
  onNewProject
}: WorkbenchNavProps) {
  const [projects, setProjects] = useState<ProjectRecord[]>([]);

  useEffect(() => {
    void createProjectClient(serviceUrl)
      .list()
      .then((list) => setProjects(list.filter((p) => p.status === "active").slice(0, 8)))
      .catch(() => setProjects([]));
  }, [serviceUrl, route.section]);

  const go = (section: WorkbenchSection, extra?: Partial<WorkbenchRoute>) => {
    onNavigate({ section, ...extra });
  };

  const item = (
    section: WorkbenchSection,
    label: string,
    icon: ReactNode,
    opts?: { accent?: boolean; onClick?: () => void }
  ) => {
    const active = opts?.onClick ? false : isNavSectionActive(route, section);
    const className = `tds-item${active ? " active" : ""}${opts?.accent && active ? " accent" : ""}`;
    if (opts?.onClick) {
      return (
        <button type="button" className={className} onClick={opts.onClick}>
          <Sq accent={opts.accent && active}>{icon}</Sq>
          <span className="tds-item-text">{label}</span>
        </button>
      );
    }
    return (
      <a
        href={formatWorkbenchHash({ section })}
        className={className}
        aria-current={active ? "page" : undefined}
        onClick={(e) => {
          e.preventDefault();
          go(section);
        }}
      >
        <Sq accent={opts?.accent && active}>{icon}</Sq>
        <span className="tds-item-text">{label}</span>
      </a>
    );
  };

  return (
    <nav className="tds-rail" aria-label="主导航">
      <div className="tds-rail-top">
        <a
          href="#/chief"
          className="tds-brand"
          onClick={(e) => {
            e.preventDefault();
            go("home");
          }}
        >
          <span className="tds-brand-mark" />
          <span className="tds-brand-name">Todos</span>
        </a>

        <div className="tds-icon-rail">
          <button
            type="button"
            className={`tds-ico${route.section === "team" ? " on" : ""}`}
            title="团队"
            aria-label="团队"
            onClick={() => go("team")}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
          </button>
          <button
            type="button"
            className={`tds-ico${route.section === "waiting" ? " on" : ""}`}
            title="收件箱"
            aria-label="收件箱"
            onClick={() => go("waiting")}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="5" width="18" height="14" rx="2" />
              <path d="m3 7 9 6 9-6" />
            </svg>
            {waitingCount > 0 ? <i className="tds-ico-badge">{waitingCount > 9 ? "9+" : waitingCount}</i> : null}
          </button>
        </div>
      </div>

      <div className="tds-rail-mid">
        <div className="tds-sec">
          {item(
            "home",
            "总管",
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
              <circle cx="12" cy="12" r="6.5" />
              <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
              <path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21" />
            </svg>
          )}
          <button
            type="button"
            className="tds-item"
            title="新建项目（任务在项目里）"
            onClick={() => {
              onNewProject?.();
            }}
          >
            <Sq>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </Sq>
            <span className="tds-item-text">新建</span>
          </button>
        </div>

        <div className="tds-sec">
          <div className="tds-sec-title">项目</div>
          {projects.length === 0 ? (
            <button type="button" className="tds-item" onClick={() => go("projects")}>
              <Sq>
                <span className="tds-sq-letter">项</span>
              </Sq>
              <span className="tds-item-text">全部项目</span>
            </button>
          ) : (
            projects.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`tds-item${route.section === "projects" ? " active" : ""}`}
                onClick={() => go("projects", { projectId: p.id })}
              >
                <Sq>
                  <span className="tds-sq-letter tds-sq-green">{p.name.slice(0, 1)}</span>
                </Sq>
                <span className="tds-item-text">{p.name}</span>
              </button>
            ))
          )}
        </div>

        <div className="tds-sec">
          <div className="tds-sec-title">资源</div>
          {item(
            "skills",
            "技能",
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 3 14.2 8.5H20l-4.6 3.4 1.8 5.6L12 14.8 6.8 17.5l1.8-5.6L4 8.5h5.8L12 3z" />
            </svg>
          )}
          {item(
            "secrets",
            "密钥",
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="5" y="11" width="14" height="9" rx="2" />
              <path d="M8 11V8a4 4 0 0 1 8 0v3" />
            </svg>
          )}
          {item(
            "connections",
            "模型服务",
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3" />
              <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2" />
            </svg>,
            { accent: true }
          )}
        </div>
      </div>

      <div className="tds-rail-bot">
        <button type="button" className="tds-install" onClick={() => go("settings")}>
          安装 App
        </button>
        <div className="tds-foot-user">
          <span className={`tds-foot-dot ${statusKind}`} />
          <div className="tds-foot-meta">
            <b>本机</b>
            <small>{statusLabel}</small>
          </div>
        </div>
      </div>
    </nav>
  );
}
