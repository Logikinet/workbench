import { buildPwaInstallGuide, pwaInstallGuideAnchorId } from "../lib/pwaInstallGuide.js";

interface PwaInstallGuidePanelProps {
  serviceUrl: string;
}

export function PwaInstallGuidePanel({ serviceUrl }: PwaInstallGuidePanelProps) {
  const guide = buildPwaInstallGuide({ serviceUrl });
  const anchorId = pwaInstallGuideAnchorId();

  return (
    <section className="workspace-panel pwa-install-guide" aria-labelledby={anchorId} id={anchorId}>
      <div className="section-heading">
        <div>
          <p className="eyebrow">WINDOWS INSTALL &amp; PWA</p>
          <h2 id={`${anchorId}-title`}>{guide.title}</h2>
        </div>
      </div>
      <p className="backup-help">{guide.summary}</p>
      <p className="backup-help">
        本机服务地址：<code>{guide.serviceUrl}</code> · 工作台入口：<code>{guide.loopbackUrl}</code>
      </p>
      <ol className="pwa-install-steps">
        {guide.steps.map((step) => (
          <li key={step.id}>
            <strong>{step.title}</strong>
            <span>{step.body}</span>
          </li>
        ))}
      </ol>
      <ul className="pwa-install-notes">
        {guide.notes.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
    </section>
  );
}
