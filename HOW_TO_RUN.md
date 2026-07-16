# 怎么真正跑起来（不是假壳）

## 正确入口

**只打开这个地址：**

```
http://127.0.0.1:41731
```

不要用坏掉的 `5173` Vite（之前会 502，看起来像假壳）。  
服务会同时提供 **API + 前端页面**。

## 启动命令（Windows）

在仓库 `personal-ai-workbench` 下：

```powershell
# 1) 构建前端（改过 UI 后需要）
npm run build --workspace=@paw/web

# 2) 用服务托管前端并启动
$env:PAW_WEB_DIST = (Resolve-Path "apps\web\dist").Path
npm run dev --workspace=@paw/service
# 或: cd apps/service; npx tsx src/main.ts
```

浏览器打开：http://127.0.0.1:41731

## 最小可用路径

1. **资源 › 模型**：至少一条连接有可用 API Key  
2. **团队 › Agents**：至少一个 `api` 角色，并绑定该连接  
3. **Chief** 发任务，或 **Todos** → **开始执行**  
4. 详情里看 **多 Agent 分工** 与时间线  

系统会：创建任务 → 出计划 → 拆子任务 → 分派 Agent → 执行。

## 默认项目

若没有项目，服务会自动创建：

- 名称：本机默认工作区  
- 路径：`%LOCALAPPDATA%\PersonalAIWorkbench\default-workspace`

执行产物写在这里。

## 代码任务说明

- 若配置了 **Codex CLI 角色**：代码类任务走隔离 worktree  
- 若没有 Codex：允许 API Agent 在**已批准项目工作区**内执行（本地可用，不是死壳）
