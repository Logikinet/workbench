# NextClaw 可复用参考（本地解压路径）

解压位置（本机）:
`C:\Users\Administrator\AppData\Local\Temp\nextclaw-extract\app`

源包: `E:\Downloads\NextClaw-Portable-0.0.220-win-x64.zip` → `resources/app.asar`

## 值得借鉴（不要照搬渠道/品牌）

1. **Launcher / Runtime 分层** (`src/runtime-service.ts`, `launcher/services/*`)
   - Tray/Launcher 与 Agent Runtime 进程解耦
   - `waitForHealth`、指数退避重启 `computeRuntimeRestartDelayMs`
   - Bundle candidate → Last Known Good、更新 Manifest

2. **MCP** (`node_modules/@modelcontextprotocol/sdk` v1.27.1)
   - 标准 client/server 传输；工具发现与调用合同
   - 本项目 Task 24/40 应用其传输与工具 schema 思路，自研服务端封装，勿依赖 Discord 等渠道包

3. **Agent Client Protocol** (`@agentclientprotocol/sdk` schema)
   - 会话、工具、通知元数据；可对齐 Task 35/41 事件形状

4. **@nextclaw packages**（仅读结构，不复制 UI/渠道）
   - `ncp-agent-runtime`, `mcp`, `extension-sdk`, `kernel`, `runtime`
   - 用于设计 Plugin SDK、Skill 目录、会话隔离时的命名与边界参考

## 明确不采用

- Electron 强制替换 PWA+Tray
- Discord/Telegram/Slack/WhatsApp 等聊天渠道扩展
- 公网/云端设备控制与品牌素材

## 对本项目任务映射

| NextClaw 能力 | PAW 任务 |
|---|---|
| Runtime process + health | 35, 44, 45 |
| MCP SDK | 24, 40 |
| Extension SDK | 46 |
| Bundle update/rollback | 45 |
| Session/tool cards 概念 | 41 |
