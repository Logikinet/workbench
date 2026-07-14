import {
  formatWorkbenchHash,
  isNavSectionActive,
  sectionLabels,
  workbenchSections,
  type WorkbenchRoute,
  type WorkbenchSection
} from "../lib/workbenchRoutes.js";

interface WorkbenchNavProps {
  route: WorkbenchRoute;
  waitingCount?: number;
  onNavigate(route: WorkbenchRoute): void;
}

const primarySections: WorkbenchSection[] = [
  "home",
  "waiting",
  "todos",
  "projects",
  "agents",
  "connections",
  "settings"
];

export function WorkbenchNav({ route, waitingCount = 0, onNavigate }: WorkbenchNavProps) {
  return (
    <nav className="workbench-nav" aria-label="工作台导航">
      <div className="workbench-nav-brand">
        <p className="eyebrow">LOCAL-FIRST</p>
        <strong>AI Workbench</strong>
      </div>
      <ul className="workbench-nav-list">
        {primarySections.map((section) => {
          const active = isNavSectionActive(route, section);
          const label = sectionLabels[section];
          const showBadge = section === "waiting" && waitingCount > 0;
          return (
            <li key={section}>
              <a
                href={formatWorkbenchHash({ section })}
                className={active ? "workbench-nav-link active" : "workbench-nav-link"}
                aria-current={active ? "page" : undefined}
                onClick={(event) => {
                  event.preventDefault();
                  onNavigate({ section });
                }}
              >
                <span>{label}</span>
                {showBadge && (
                  <span className="nav-badge" aria-label={`${waitingCount} 项待处理`}>
                    {waitingCount > 99 ? "99+" : waitingCount}
                  </span>
                )}
              </a>
            </li>
          );
        })}
      </ul>
      <p className="workbench-nav-hint">移动端可查看状态、回答 AskUser 与批准/停止。</p>
      {/* Keep section enum referenced for type safety if list is curated. */}
      <span className="visually-hidden">{workbenchSections.join(",")}</span>
    </nav>
  );
}
