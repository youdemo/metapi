# ⚙️ 配置说明

本文档列出 Metapi 的全部环境变量配置。

[返回文档中心](./README.md)

---

## 必填配置

> ⚠️ 以下变量**必须修改**，不要使用默认值。

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `AUTH_TOKEN` | 管理后台登录令牌 | `change-me-admin-token` |
| `PROXY_TOKEN` | 代理接口 Bearer Token（下游客户端使用此值作为 API Key） | `change-me-proxy-sk-token` |

## 基础配置

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `PORT` | 服务监听端口 | `4000` |
| `DATA_DIR` | 数据目录（SQLite 数据库存储位置） | `./data` |
| `TZ` | 时区 | `Asia/Shanghai` |
| `ACCOUNT_CREDENTIAL_SECRET` | 账号凭证加密密钥（用于加密存储的上游账号密码） | 默认使用 `AUTH_TOKEN` |

## 定时任务

| 变量名 | 说明 | 默认值 | 示例 |
|--------|------|--------|------|
| `CHECKIN_CRON` | 自动签到计划 | `0 8 * * *` | 每天 8:00 |
| `BALANCE_REFRESH_CRON` | 余额刷新计划 | `0 * * * *` | 每小时整点 |

Cron 表达式格式：`分 时 日 月 周`（标准五段式）

常用示例：
- `0 8 * * *` — 每天 08:00
- `0 */2 * * *` — 每 2 小时
- `30 7,12,20 * * *` — 每天 07:30、12:30、20:30

## 智能路由

Metapi 的路由引擎按多因子加权选择最优通道。

### 成本信号优先级

```
实测成本（代理日志） → 账号配置成本 → 目录参考价 → 兜底默认值
```

### 路由权重参数

| 变量名 | 说明 | 默认值 | 范围 |
|--------|------|--------|------|
| `ROUTING_FALLBACK_UNIT_COST` | 无成本信号时的默认单价 | `1` | > 0 |
| `BASE_WEIGHT_FACTOR` | 基础权重因子 | `0.5` | 0~1 |
| `VALUE_SCORE_FACTOR` | 性价比评分因子 | `0.5` | 0~1 |
| `COST_WEIGHT` | 成本权重（越大越偏向低成本通道） | `0.4` | 0~1 |
| `BALANCE_WEIGHT` | 余额权重（越大越偏向余额充足的通道） | `0.3` | 0~1 |
| `USAGE_WEIGHT` | 使用率权重（越大越偏向使用较少的通道） | `0.3` | 0~1 |

> 三个权重之和建议为 1.0，但不强制。

### 路由预设建议

| 场景 | COST_WEIGHT | BALANCE_WEIGHT | USAGE_WEIGHT |
|------|:-----------:|:--------------:|:------------:|
| **成本优先** | 0.7 | 0.2 | 0.1 |
| **均衡（默认）** | 0.4 | 0.3 | 0.3 |
| **稳定优先** | 0.2 | 0.5 | 0.3 |
| **轮转均匀** | 0.1 | 0.1 | 0.8 |

## 安全配置

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `ADMIN_IP_ALLOWLIST` | 管理端 IP 白名单（逗号分隔） | 空（不限制） |

示例：`ADMIN_IP_ALLOWLIST=192.168.1.0/24,10.0.0.1`

## 下游 API Key 策略

除了全局 `PROXY_TOKEN`，Metapi 支持在管理后台「设置 → 下游 API Key」中创建多个项目级下游 Key。

每个 Key 可独立配置以下约束：

| 字段 | 说明 | 示例 |
|------|------|------|
| `name` | Key 名称（仅供标识） | `team-backend` |
| `expiresAt` | 过期时间 | `2026-12-31T23:59:59Z` |
| `maxCost` | 累计费用上限 | `100`（超限后拒绝请求） |
| `maxRequests` | 累计请求数上限 | `10000` |
| `supportedModels` | 模型白名单（JSON 数组） | `["gpt-4o", "claude-*", "re:deepseek.*"]` |
| `allowedRouteIds` | 可走的路由 ID 白名单 | `[1, 3, 5]` |
| `siteWeightMultipliers` | 站点权重倍率 | `{"1": 2.0, "3": 0.5}` |

模型白名单支持三种匹配模式：

- **精确匹配**：`gpt-4o`
- **通配符**：`claude-*`（glob 风格）
- **正则表达式**：`re:deepseek.*`（`re:` 前缀）

## 通知渠道

### Webhook

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `WEBHOOK_ENABLED` | 启用 Webhook 通知 | `true` |
| `WEBHOOK_URL` | Webhook 推送地址 | 空 |

### Bark（iOS 推送）

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `BARK_ENABLED` | 启用 Bark 推送 | `true` |
| `BARK_URL` | Bark 推送地址 | 空 |

### Server酱

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `SERVERCHAN_ENABLED` | 启用 Server酱 通知 | `true` |
| `SERVERCHAN_KEY` | Server酱 SendKey | 空 |

### SMTP 邮件

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `SMTP_ENABLED` | 启用邮件通知 | `false` |
| `SMTP_HOST` | SMTP 服务器地址 | 空 |
| `SMTP_PORT` | SMTP 端口 | `587` |
| `SMTP_SECURE` | 使用 SSL/TLS | `false` |
| `SMTP_USER` | SMTP 用户名 | 空 |
| `SMTP_PASS` | SMTP 密码 | 空 |
| `SMTP_FROM` | 发件人地址 | 空 |
| `SMTP_TO` | 收件人地址 | 空 |

### 告警控制

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `NOTIFY_COOLDOWN_SEC` | 相同告警冷却时间（秒），防止同一事件重复通知 | `300` |

## 运行时配置

除环境变量外，以下参数可在管理后台「设置」页面中动态调整，无需重启：

- 路由权重参数
- 通知渠道地址
- SMTP 配置
- 告警冷却时间

运行时配置存储在 SQLite 数据库中，优先级高于环境变量默认值。

## 下一步

- [部署指南](./deployment.md) — Docker Compose 与反向代理
- [客户端接入](./client-integration.md) — 对接下游应用
