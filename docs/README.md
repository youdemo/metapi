# 📚 Metapi 文档中心

<div align="center">

**中转站的中转站 — 将分散的 AI 中转站聚合为一个统一网关**

[返回项目主页](../README.md)

</div>

---

## 文档站运行

```bash
npm run docs:dev
```

构建静态站点：

```bash
npm run docs:build
```

## 快速导航

| 文档 | 适合谁 | 解决的问题 |
|------|--------|------------|
| 🚀 [快速上手](./getting-started.md) | 首次使用者 | 10 分钟完成部署与首次请求 |
| 🚢 [部署指南](./deployment.md) | 部署维护者 | Docker Compose、反向代理、升级回滚 |
| ⚙️ [配置说明](./configuration.md) | 管理员 | 全部环境变量、路由参数、通知渠道 |
| 🔌 [客户端接入](./client-integration.md) | 下游应用接入者 | Open WebUI、Cherry Studio、Cursor 等接入 |
| 🔧 [运维手册](./operations.md) | 运维人员 | 备份恢复、日志排查、健康检查 |
| ❓ [常见问题](./faq.md) | 所有用户 | 常见报错与修复路径 |
| 🧩 [FAQ/教程贡献规范](./community/faq-tutorial-guidelines.md) | 社区贡献者 | 统一沉淀 FAQ、教程与排障经验 |
| 📁 [目录规范](./project-structure.md) | 开发者 | 项目目录组织与约定 |

## 架构概览

**下游客户端**（Cursor · Claude Code · Codex · Open WebUI · Cherry Studio 等）
&emsp;↓ &ensp;`Authorization: Bearer <PROXY_TOKEN>`
**Metapi 网关**
&emsp;• 统一代理 `/v1/*` — 兼容 OpenAI / Claude 全接口
&emsp;• 智能路由引擎 — 按成本、余额、可用率加权选路，失败自动冷却与重试
&emsp;• 模型发现 — 自动聚合上游全部模型，零配置
&emsp;• 格式转换 — OpenAI ⇄ Claude 双向透明转换
&emsp;• 自动签到 · 余额管理 · 告警通知 · 数据看板
&emsp;↓
**上游平台**（New API · One API · OneHub · DoneHub · Veloera · AnyRouter · Sub2API …）

## 核心概念

- **站点 (Site)**：一个上游中转站实例（如 New API、OneHub 等）
- **账号 (Account)**：在某站点上注册的用户账号
- **Token**：账号下的 API Key，用于访问该站点的 API
- **路由 (Route)**：一条模型匹配规则，如 `claude-sonnet-4-6`
- **通道 (Channel)**：路由下的一条 Token 链路，一个路由可有多个通道
- **代理 (Proxy)**：Metapi 对下游暴露的统一 API 入口

## 开源协作

- 📝 贡献流程：[CONTRIBUTING.md](../CONTRIBUTING.md)
- 🛡️ 安全策略：[SECURITY.md](../SECURITY.md)
- 📜 行为准则：[CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md)
