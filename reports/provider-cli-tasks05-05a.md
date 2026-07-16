# Provider Connection + pawb CLI（任务 05 / 05A）

依据：`cli修改.md`（复刻 Todos.dev Provider 体验，不复制私有 CLI 代码）

## 已实现

### 05 — 统一 Provider Connection

| 能力 | 说明 |
|------|------|
| 数据模型 | `ProviderConnection` / `ProviderModel`（`providerTypes.ts`） |
| 适配器 | OpenAI-compatible、Anthropic、Gemini、Ollama |
| 认证 | api-key / environment / none / **oauth**（CLI 交互登录 + vault 存储 + 自动 refresh） |
| 凭据 | 仅 `credentialRef` + `credentialConfigured`；密文在 Windows Credential Vault |
| API | `GET/POST /api/providers`、`test`、`models`、`credential`、`logout`、`catalog` |
| 失效行为 | 既有 `pauseForConnection` 保留；测试失败映射 `auth_failed` / `unreachable` / `model_not_found` |

### 05A — pawb CLI（对齐 todos-dev-cli.zip 交互）

```text
npm run pawb -- health
npm run pawb -- provider                 # 主菜单 Add/List/Remove/…
npm run pawb -- provider add
npm run pawb -- provider list [--json]
npm run pawb -- provider remove <id> [-y]
npm run pawb -- provider test <id>       # workbench 扩展
npm run pawb -- provider login <id>
npm run pawb -- provider logout <id>
npm run pawb -- harness status codex
```

**与 todos CLI 对齐的 API 配置路径：**

| 步骤 | 行为 |
|------|------|
| 主菜单 | `What do you want to do?` → Add / List / Remove / Exit |
| 预设 | 可搜索 `Pick a preset`：OpenAI / Anthropic / Gemini / Ollama / Custom |
| 内置 | 仅认证：多 auth 时 `Subscription (OAuth)` / `API key`；写入后 `Stored API key for built-in…` |
| Custom/Ollama | `Provider name` → `Base URL` → `API key (empty to skip…)` → 多模型 id + context/max tokens/reasoning |
| 列表 | `PROVIDER  TYPE  AUTH  MODELS` 表（与 todos 同列） |
| 密钥 | 遮罩 + `$ENV_VAR` / `!shell-command`；**禁止** `--api-key`；非交互用 `--api-key-env` |
| 同步 | 全部经 Agent Service `/api/providers`，PWA 共用 |

- 仅调用 `http://127.0.0.1:41731`（可用 `PAW_SERVICE_URL` 覆盖）
- 安装脚本注册 `%LOCALAPPDATA%\PersonalAIWorkbench\bin\pawb.cmd` 到用户 PATH

## 与 Connections 的关系

- Provider 元数据叠在既有 `ConnectionService` 上，PWA「Connections」与 `/api/providers` 共享同一凭据库。
- CLI 添加后立即出现在 `GET /api/providers` / 连接列表。

## 验证

```powershell
npx vitest run apps/service/src/providers/providerService.test.ts
npx tsc -p apps/cli/tsconfig.json --noEmit
```

## OAuth（已接通）

交互登录在 **CLI 进程**完成（与 todos 一致，依赖 `@earendil-works/pi-ai/oauth`）：

| Provider | 方式 |
|----------|------|
| `anthropic` | 浏览器 + PKCE（本地 callback `127.0.0.1:53692`） |
| `openai-codex` | 浏览器或 device code |
| `github-copilot` | device code |
| `radius` | Radius gateway OAuth |

流程：`runInteractiveOAuthLogin` → `POST /api/providers` → `POST /api/providers/:id/oauth/complete`  
Service 将 tokens 写入 Credential Vault；调用时 `getOAuthApiKey` 自动 refresh。

```powershell
npm run pawb -- provider add
# 选 Anthropic / OpenAI Codex / GitHub Copilot → Subscription (OAuth)
```

## 残余 / 后续

- xAI 等仅有 API key 的渠道无 subscription OAuth（pi-ai 未提供实现）
- 备份导出已排除 vault 密钥；恢复后仍需重新 OAuth / 配置凭据
- Role 侧已使用 `connectionId`；文档中的 `providerConnectionId` 与 connection id 同一标识
- PWA 内嵌 OAuth UI 未做（仍走 CLI 或 API key）
