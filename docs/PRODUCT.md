# 产品：本地 todos（按桌面 HTML 快照 + 官方流程）

## 操作流（照搬）

```
总管说话 / 新建 Todo
  → Planning
  → Plan ready
  → 确认并构建
  → Building
  → Review → Done
```

## 信息架构（对齐 todos HTML）

| 路由 | 页面 |
|------|------|
| `#/chief` | 总管 |
| `#/inbox` | 收件箱 |
| `#/todos` | Todos 板 |
| `#/projects` | 项目 |
| `#/resources/providers` | 模型 |
| `#/resources/skills` | 技能 |
| `#/resources/secrets` | 密钥 |
| `#/agents` | Agents |
| `#/app` | 团队 |
| `?panel=todo:id` | 右侧 Todo 抽屉 |

## 入口

http://127.0.0.1:41731  
强制刷新后从 **总管** 开始。
