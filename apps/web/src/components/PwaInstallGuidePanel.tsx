import { buildPwaInstallGuide, pwaInstallGuideAnchorId } from "../lib/pwaInstallGuide.js";
import { ListCard, Panel, Stack, Tag } from "./ui.js";

interface PwaInstallGuidePanelProps {
  serviceUrl: string;
}

export function PwaInstallGuidePanel({ serviceUrl }: PwaInstallGuidePanelProps) {
  const guide = buildPwaInstallGuide({ serviceUrl });
  const anchorId = pwaInstallGuideAnchorId();

  return (
    <div id={anchorId}>
      <Panel eyebrow="WINDOWS INSTALL & PWA" title={guide.title} description={guide.summary}>
        <p className="m-0 text-sm text-muted">
          本机服务地址：<code className="rounded bg-field px-1.5 py-0.5 text-foreground">{guide.serviceUrl}</code>
          {" · "}
          工作台入口：<code className="rounded bg-field px-1.5 py-0.5 text-foreground">{guide.loopbackUrl}</code>
        </p>

        <Stack>
          {guide.steps.map((step, index) => (
            <ListCard
              key={step.id}
              actions={<Tag color="accent">步骤 {index + 1}</Tag>}
            >
              <strong className="block text-sm text-foreground">{step.title}</strong>
              <span className="block text-sm text-muted">{step.body}</span>
            </ListCard>
          ))}
        </Stack>

        {guide.notes.length > 0 ? (
          <Stack>
            {guide.notes.map((note) => (
              <p key={note} className="m-0 text-sm text-muted">
                {note}
              </p>
            ))}
          </Stack>
        ) : null}
      </Panel>
    </div>
  );
}
