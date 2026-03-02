# 🚢 部署指南

[返回文档中心](./README.md)

---

## Docker Compose 部署（推荐）

### 标准步骤

```bash
mkdir metapi && cd metapi

# 创建 docker-compose.yml（参见快速上手）
# 设置环境变量
export AUTH_TOKEN=your-admin-token
export PROXY_TOKEN=your-proxy-sk-token

# 启动
docker compose up -d
```

### 使用 `.env` 文件

如果不想每次 export，可以创建 `.env` 文件：

```bash
# .env
AUTH_TOKEN=your-admin-token
PROXY_TOKEN=your-proxy-sk-token
TZ=Asia/Shanghai
PORT=4000
```

```bash
docker compose --env-file .env up -d
```

> ⚠️ `.env` 文件包含敏感信息，请勿提交到 Git 仓库。

## Docker 命令部署

```bash
docker run -d --name metapi \
  -p 4000:4000 \
  -e AUTH_TOKEN=your-admin-token \
  -e PROXY_TOKEN=your-proxy-sk-token \
  -e TZ=Asia/Shanghai \
  -v ./data:/app/data \
  --restart unless-stopped \
  1467078763/metapi:latest
```

> **路径说明：**
> - `./data:/app/data` — 相对路径，数据存到当前目录下的 `data` 文件夹
> - 也可以使用绝对路径：`/your/custom/path:/app/data`

## Release 包部署（免 Docker）

适用于没有 Docker 环境的服务器，或 Windows / macOS 桌面使用场景。

### 前置条件

- Node.js 20+（推荐 22 LTS）

### 步骤

1. 从 [Releases](https://github.com/cita-777/metapi/releases) 下载与你系统匹配的压缩包（Linux / Windows / macOS）
2. 解压后进入目录

Linux / macOS：

```bash
export AUTH_TOKEN=your-admin-token
export PROXY_TOKEN=your-proxy-sk-token
export PORT=4000
export DATA_DIR=./data
./start.sh
```

Windows（PowerShell）：

```powershell
$env:AUTH_TOKEN="your-admin-token"
$env:PROXY_TOKEN="your-proxy-sk-token"
$env:PORT="4000"
$env:DATA_DIR="./data"
.\start.bat
```

`start.sh` / `start.bat` 的作用是：

- 先检查 `better-sqlite3` 与当前 Node.js ABI 是否兼容
- 若检测到 ABI 不匹配，会自动尝试 `npm rebuild better-sqlite3`
- 若重建失败，会回退到 `npm ci --omit=dev` 重新安装运行时依赖
- 最后执行数据库迁移并启动服务

> [!NOTE]
> 如果本机 Node 主版本与打包时不同（例如包内依赖基于 Node 22，而本机是 Node 24），首次启动可能触发自动重建，需联网。

### Release 包升级

1. 下载新版本的 Release 包
2. 解压覆盖旧文件（`data/` 目录不受影响）
3. 重新启动即可

---

## 反向代理

### Nginx

流式请求（SSE）需要关闭缓冲，否则流式输出会异常：

```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;

    ssl_certificate     /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:4000;

        # SSE 关键配置
        proxy_buffering off;
        proxy_cache off;
        proxy_set_header Connection '';
        proxy_http_version 1.1;
        chunked_transfer_encoding off;

        # 标准代理头
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # 超时设置（长对话场景）
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
```

### Caddy

```
your-domain.com {
    reverse_proxy localhost:4000 {
        flush_interval -1
    }
}
```

## 升级

```bash
# 拉取最新镜像
docker compose pull

# 重新启动（数据不受影响）
docker compose up -d

# 清理旧镜像
docker image prune -f
```

## 回滚

如果升级后出现问题：

1. **升级前备份**（建议每次升级前执行）：

```bash
cp -r data/ data-backup-$(date +%Y%m%d)/
```

2. **回滚到指定版本**：

```bash
# 修改 docker-compose.yml 中的 image tag
# 例如：image: 1467078763/metapi:v1.0.0

# 恢复数据
rm -rf data/
cp -r data-backup-20260228/ data/

# 重启
docker compose up -d
```

## 数据持久化

Metapi 的所有运行数据存储在 SQLite 数据库中，位于 `DATA_DIR`（默认 `./data`）目录下。

只要挂载了该目录，升级、重启都不会丢失数据。

### 备份策略建议

- 每日自动备份 `data/` 目录
- 保留最近 7~30 天的备份
- 重要操作前手动快照

## 文档站部署

Metapi 使用 [VitePress](https://vitepress.dev) 构建文档站，支持本地预览和 GitHub Pages 自动部署。

### 本地预览

```bash
npm run docs:dev
```

访问 `http://localhost:4173` 查看文档站。

### 构建静态站点

```bash
npm run docs:build
```

构建产物位于 `docs/.vitepress/dist/`，可部署到任意静态站点托管服务。

### GitHub Pages 自动部署

推送到 `main` 分支后，`.github/workflows/docs-pages.yml` 会自动构建并部署到 GitHub Pages。

首次使用需在仓库设置中开启：

`Settings → Pages → Build and deployment → Source: GitHub Actions`

---

## 下一步

- [配置说明](./configuration.md) — 详细环境变量
- [运维手册](./operations.md) — 日志排查、健康检查
