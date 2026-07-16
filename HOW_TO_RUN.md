# 怎么真正跑起来

## 正确入口

**只打开：**

```text
http://127.0.0.1:41731
```

服务同时提供 **API + 前端**（需设置 `PAW_WEB_DIST`）。

## 启动（Windows，仓库根目录）

```powershell
npm install
npm run build --workspace=@paw/web

$env:PAW_WEB_DIST = (Resolve-Path "apps\web\dist").Path
npm run dev --workspace=@paw/service
```

改 UI 后重新 build web，再重启 service。

## 最小可用路径（todos 风格）

1. **资源 › 模型服务** — 配置 API Key  
2. **设置 › GitHub** — 粘贴 PAT，关联帐号  
3. **侧栏 + 新建** — 创建**项目**，选择 GitHub 仓库  
4. 项目内 **+ 新建任务** → **开始**（规划 / 执行 Agent）  
5. **确认方案** → 执行 → 看 Diff / Token → **完成**  

## 数据位置

| 内容 | 路径 |
| --- | --- |
| 状态 / 凭据索引 | `%LOCALAPPDATA%\PersonalAIWorkbench\` |
| GitHub clone 项目 | `...\github-clones\<owner>__<repo>` |
| 默认兜底工作区 | `...\default-workspace` |

## 健康检查

```powershell
curl http://127.0.0.1:41731/api/health
```

完整说明见 [README.md](./README.md)。
