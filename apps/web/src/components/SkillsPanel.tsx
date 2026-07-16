import { useEffect, useMemo, useState } from "react";
import {
  createSkillClient,
  type SkillCatalogEntry,
  type SkillRecord
} from "../lib/skills.js";
import { ListIcon, TdsEmpty, TdsGhostButton, TdsPrimaryButton } from "./TdsPage.js";

interface SkillsPanelProps {
  serviceUrl: string;
  available: boolean;
  dataEpoch?: number;
}

export function SkillsPanel({ serviceUrl, available, dataEpoch = 0 }: SkillsPanelProps) {
  const client = useMemo(() => createSkillClient(serviceUrl), [serviceUrl]);
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  const [catalog, setCatalog] = useState<SkillCatalogEntry[]>([]);
  const [tab, setTab] = useState<"installed" | "catalog">("installed");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const reload = async () => {
    if (!available) return;
    try {
      const [list, cat] = await Promise.all([
        client.list(),
        client.catalog(query).catch(() => [] as SkillCatalogEntry[])
      ]);
      setSkills(list);
      setCatalog(Array.isArray(cat) ? cat : []);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "无法加载技能");
    }
  };

  useEffect(() => {
    void reload();
  }, [available, dataEpoch, serviceUrl]);

  useEffect(() => {
    if (tab !== "catalog" || !available) return;
    const t = setTimeout(() => {
      void client
        .catalog(query)
        .then((cat) => setCatalog(Array.isArray(cat) ? cat : []))
        .catch(() => setCatalog([]));
    }, 200);
    return () => clearTimeout(t);
  }, [query, tab, available, client]);

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      setNotice(label);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
    } finally {
      setBusy(false);
    }
  };

  const installedIds = new Set(
    skills.flatMap((s) => [s.id, s.catalogId].filter((x): x is string => Boolean(x)))
  );
  const filteredInstalled = skills.filter((s) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return (
      s.name.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q) ||
      s.tags.some((t) => t.toLowerCase().includes(q))
    );
  });

  return (
    <div className="tds-providers">
      {notice ? <div className="tds-banner ok">{notice}</div> : null}
      {error ? <div className="tds-banner err">{error}</div> : null}

      <div className="tds-filter-row">
        <button
          type="button"
          className={tab === "installed" ? "tds-filter-chip active" : "tds-filter-chip"}
          onClick={() => setTab("installed")}
        >
          已安装（{skills.length})
        </button>
        <button
          type="button"
          className={tab === "catalog" ? "tds-filter-chip active" : "tds-filter-chip"}
          onClick={() => setTab("catalog")}
        >
          Catalog
        </button>
        <input
          className="tds-inline-search"
          placeholder="搜索技能…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <TdsGhostButton disabled={!available || busy} onClick={() => void reload()}>
          刷新
        </TdsGhostButton>
      </div>

      {!available ? (
        <TdsEmpty title="服务离线" description="请先启动本地服务以管理技能。" />
      ) : tab === "installed" ? (
        filteredInstalled.length === 0 ? (
          <TdsEmpty
            icon={<ListIcon />}
            title="尚未安装技能"
            description="从目录安装 Agent 可用的技能。"
            action={
              <TdsPrimaryButton onClick={() => setTab("catalog")}>打开目录</TdsPrimaryButton>
            }
          />
        ) : (
          <div className="tds-provider-list">
            {filteredInstalled.map((skill) => (
              <article key={skill.id} className="tds-provider-row">
                <div className="tds-provider-main">
                  <div className="tds-provider-title-row">
                    <h3>{skill.name}</h3>
                    <span className={`tds-chip ${skill.enabled ? "success" : "default"}`}>
                      {skill.enabled ? "已启用" : "已禁用"}
                    </span>
                    <span className={`tds-chip ${skill.trusted ? "success" : "warning"}`}>
                      {skill.trusted ? "已信任" : "未信任"}
                    </span>
                    <span className="tds-chip default">{skill.source}</span>
                  </div>
                  <p className="tds-muted">{skill.description || "无描述"}</p>
                  <p className="tds-muted">
                    v{skill.version}
                    {skill.tags?.length ? ` · ${skill.tags.slice(0, 4).join(", ")}` : ""}
                    {skill.requiredTools?.length
                      ? ` · tools: ${skill.requiredTools.slice(0, 3).join(", ")}`
                      : ""}
                  </p>
                </div>
                <div className="tds-provider-actions">
                  {!skill.trusted ? (
                    <TdsGhostButton
                      disabled={busy}
                      onClick={() =>
                        void act(`已信任 “${skill.name}”`, () => client.trust(skill.id))
                      }
                    >
                      Trust
                    </TdsGhostButton>
                  ) : (
                    <TdsGhostButton
                      disabled={busy}
                      onClick={() =>
                        void act(`已撤销信任：「${skill.name}」`, () =>
                          client.revokeTrust(skill.id)
                        )
                      }
                    >
                      Revoke
                    </TdsGhostButton>
                  )}
                  {skill.enabled ? (
                    <TdsGhostButton
                      disabled={busy}
                      onClick={() =>
                        void act(`已禁用 “${skill.name}”`, () => client.disable(skill.id))
                      }
                    >
                      禁用
                    </TdsGhostButton>
                  ) : (
                    <TdsGhostButton
                      disabled={busy}
                      onClick={() =>
                        void act(`已启用 “${skill.name}”`, () => client.enable(skill.id))
                      }
                    >
                      启用
                    </TdsGhostButton>
                  )}
                </div>
              </article>
            ))}
          </div>
        )
      ) : catalog.length === 0 ? (
        <TdsEmpty
          icon={<ListIcon />}
          title="目录为空"
          description="无匹配条目。服务启动后会出现内置技能种子。"
        />
      ) : (
        <div className="tds-provider-list">
          {catalog.map((entry) => {
            const installed = installedIds.has(entry.id);
            return (
              <article key={entry.id} className="tds-provider-row">
                <div className="tds-provider-main">
                  <div className="tds-provider-title-row">
                    <h3>{entry.name}</h3>
                    {entry.recommended ? <span className="tds-chip success">推荐</span> : null}
                    {installed ? <span className="tds-chip default">已安装</span> : null}
                  </div>
                  <p className="tds-muted">{entry.description}</p>
                  <p className="tds-muted">
                    v{entry.version}
                    {entry.tags?.length ? ` · ${entry.tags.slice(0, 4).join(", ")}` : ""}
                  </p>
                </div>
                <div className="tds-provider-actions">
                  <TdsPrimaryButton
                    disabled={busy || installed}
                    onClick={() =>
                      void act(`已安装「${entry.name}」`, () =>
                        client.installFromCatalog(entry.id)
                      )
                    }
                  >
                    {installed ? "已安装" : "安装"}
                  </TdsPrimaryButton>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
