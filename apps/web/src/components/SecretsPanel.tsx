/**
 * todos /resources/secrets — 本地映射到说明 + 引导去模型页（密钥在 Credential Vault）
 */

import { TdsPage, TdsPrimaryButton } from "./TdsPage.js";
import type { WorkbenchRoute } from "../lib/workbenchRoutes.js";

interface SecretsPanelProps {
  onNavigate(route: WorkbenchRoute): void;
}

export function SecretsPanel({ onNavigate }: SecretsPanelProps) {
  return (
    <TdsPage
      kicker="资源"
      title="密钥"
      description="API Key 保存在本机 Credential Vault，不上传。在「模型」页添加服务商时写入。"
    >
      <div className="tds-empty-card">
        <p className="tds-empty-title">密钥随模型连接管理</p>
        <p className="tds-empty-desc">
          todos 的 Secrets 对应本机 Provider / 连接凭据。添加或轮换 Key 请到「模型」。
        </p>
        <TdsPrimaryButton onClick={() => onNavigate({ section: "connections" })}>
          前往模型
        </TdsPrimaryButton>
      </div>
    </TdsPage>
  );
}
