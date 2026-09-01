# PSD 渲染服务平台 - 部署指南

> 第三期改造版（纯 SQLite + 内存队列，移除 PostgreSQL/Redis 依赖）
> 适用版本：v0.3.0+

## 目录

- [1. 部署架构](#1-部署架构)
- [2. 服务器侧部署（Docker Compose）](#2-服务器侧部署docker-compose)
- [3. 渲染机侧部署（Electron Worker）](#3-渲染机侧部署electron-worker)
- [4. Nginx 反向代理（可选但推荐）](#4-nginx-反向代理可选但推荐)
- [5. 健康检查与监控](#5-健康检查与监控)
- [6. 运维操作](#6-运维操作)
- [7. 故障排查](#7-故障排查)
- [8. 数据库与队列设计说明](#8-数据库与队列设计说明)

---

## 1. 部署架构

```
┌─────────────────────────────────────────────────────────────┐
│  腾讯云 CVM（Linux，Docker Compose）                          │
│                                                              │
│  ┌────────────┐    ┌────────────────────────────┐           │
│  │   Nginx    │───▶│  API 容器（单容器）          │           │
│  │ (HTTPS+限流)│    │  - Fastify + Admin UI      │           │
│  └────────────┘    │  - SQLite (WAL, /data 卷)  │           │
│                    │  - 内存队列                 │           │
│  ┌────────────┐    │  - 本地存储 / COS 客户端    │           │
│  │  Admin UI  │    └────────────────────────────┘           │
│  │  /admin     │                                              │
│  └────────────┘                                              │
└──────────────────────────┼──────────────────────────────────┘
                           │
                           │ 内网 / 公网
                           │
┌──────────────────────────┼──────────────────────────────────┐
│  Windows 渲染机           │                                   │
│                          │                                   │
│  ┌────────────────────────┴───┐                              │
│  │   Electron Worker          │                              │
│  │   - 长轮询 claim           │                              │
│  │   - 调用 Photoshop JSX     │                              │
│  │   - 上传结果到 COS         │                              │
│  └────────────┬───────────────┘                              │
│               │                                              │
│               ▼                                              │
│  ┌──────────────────────────┐                                │
│  │   Photoshop 2024 (25.x)  │                                │
│  │   COM 桥接执行 JSX        │                                │
│  └──────────────────────────┘                                │
└──────────────────────────────────────────────────────────────┘

                  ┌──────────────────┐
                  │   腾讯云 COS     │
                  │  (PSD/字体/结果) │
                  │   走内网域名     │
                  └──────────────────┘
```

### 部署边界

| 组件 | 部署位置 | 职责 |
|------|---------|------|
| Fastify API + Admin UI + Queue | CVM Docker | 业务逻辑、调度、鉴权 |
| SQLite 数据文件 | CVM Docker `/data` 卷 | 任务/模板/Worker/审计日志 |
| Nginx | CVM 宿主机 | HTTPS 终止、限流、白名单 |
| Electron Worker | Windows 渲染机 | 调用 PS、执行 JSX |
| Photoshop 2024 | Windows 渲染机 | 渲染引擎 |
| 腾讯云 COS | 云对象存储 | PSD/字体/输入图片/渲染结果 |

> **第三期改造**：移除了 PostgreSQL 与 Redis 容器，数据库改用 SQLite（WAL 模式），
> 队列改用内存队列。适合 10-20 任务并发的单机部署场景。

### 端口暴露策略

| 端口 | 服务 | 暴露范围 | 说明 |
|------|------|---------|------|
| 80/443 | Nginx | 公网 | 仅 HTTPS 对外 |
| 3000 | API | 仅 127.0.0.1 | 通过 Nginx 代理 |
| 3000/admin | Admin UI | 仅内网 | 由前置网关限制内网 IP |

---

## 2. 服务器侧部署（Docker Compose）

### 2.1 前置要求

- Linux 服务器（推荐腾讯云 CVM 2核4G+，SQLite 部署 1核2G 即可）
- Docker 20.10+
- Docker Compose v2.0+
- 已创建腾讯云 COS Bucket（与 CVM 同地域，可选；本地存储也可）
- 域名 + DNS 解析（如 api.example.com）
- SSL 证书（Let's Encrypt 免费证书）

### 2.2 配置 .env

```bash
cd psd-render-api
cp .env.example .env
```

编辑 `.env`，按生产环境修改以下关键项：

```ini
# ===== 必须修改的项 =====

# 运行模式
NODE_ENV=production

# API Key（外部调用方使用，至少 8 位强随机字符串）
API_KEY=sk_live_<strong-random-string>

# Worker 令牌密钥（至少 8 位强随机字符串）
# 注意：此密钥同时用于 secret-crypto.ts 的 AES-256-GCM 加密 key 派生，
#       一旦设定后不可随意修改（修改后已加密的 COS Secret 等配置将无法解密）
WORKER_TOKEN_SECRET=<strong-random-string>

# Worker 注册密钥（推荐使用 Admin UI 一次性授权码模式，无需在此配置）
# 此字段为兼容备选：授权码模式优先校验，仅作长期密钥备用
# WORKER_REGISTER_SECRET=<strong-random-string>

# Admin 引导密码（首次启动创建管理员账号，必须修改）
ADMIN_BOOTSTRAP_PASSWORD=<strong-password>

# ===== 数据库（SQLite，由 docker-compose 注入） =====
# DATABASE_URL 无需在 .env 配置，docker-compose.yml 已固定为 file:/data/psd-render.db

# ===== 存储后端 =====
# 可选 local（本地磁盘）或 cos（腾讯云对象存储）
STORAGE_BACKEND=cos

# COS 配置（STORAGE_BACKEND=cos 时必填）
COS_SECRET_ID=<your-secret-id>
COS_SECRET_KEY=<your-secret-key>
COS_BUCKET=psd-render-prod
COS_REGION=ap-guangzhou
# 内网域名（与 CVM 同地域走内网，免公网流量费）
COS_INTERNAL_DOMAIN=cos.ap-guangzhou.myqcloud.com

# ===== 任务队列（固定为 memory，无需 Redis）=====
QUEUE_BACKEND=memory

# ===== CORS（按实际业务域名配置）=====
CORS_ORIGINS=https://your-webapp.example.com,https://admin.example.com

# ===== Admin 鉴权（生产必须开启）=====
ADMIN_AUTH_ENABLED=true
# Admin IP 白名单（强烈建议配置，仅允许运维人员 IP）
ADMIN_IP_WHITELIST=10.0.0.0/8,203.0.113.10

# ===== 告警通知（可选，按需配置）=====
ALERT_WEBHOOK_URL=https://your-webhook.example.com/alert
ALERT_FEISHU_WEBHOOK_URL=
ALERT_DINGTALK_WEBHOOK_URL=
ALERT_MIN_SEVERITY=WARN
```

### 2.3 构建并启动

```bash
# 构建镜像（首次约 5-10 分钟，sharp 编译较慢）
docker compose build

# 启动服务（单容器）
docker compose up -d

# 查看启动日志
docker compose logs -f api

# 验证健康检查
curl http://127.0.0.1:3000/health
# 期望返回：{"status":"ok",...}
```

### 2.4 验证部署

```bash
# 1. 检查容器状态（应 healthy）
docker compose ps

# 2. 检查 API 健康
curl -s http://127.0.0.1:3000/health | jq

# 3. 检查 Admin UI 可访问
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3000/admin
# 期望：200 或 302（重定向到登录页）

# 4. 检查 SQLite 数据文件
docker compose exec api ls -la /data/
# 期望看到 psd-render.db + psd-render.db-wal + psd-render.db-shm

# 5. 验证 SQLite PRAGMA 已启用
docker compose exec api sqlite3 /data/psd-render.db "PRAGMA journal_mode;"
# 期望输出：wal

# 6. 用 API Key 测试鉴权
curl -s -H "Authorization: Bearer $API_KEY" \
     http://127.0.0.1:3000/v1/templates | jq
```

### 2.5 数据库说明

- **首次部署**：Dockerfile CMD 中 `prisma migrate deploy` 会自动应用 `prisma/migrations/` 中所有 SQLite 迁移，创建全部表结构
- **后续升级**：新增迁移文件后，重启容器会自动应用增量迁移
- **Schema 变更流程**：
  ```bash
  # 本地开发时创建新迁移
  npm run prisma:migrate -- --name <change-name>
  # 提交迁移文件到代码仓库
  # 生产部署时重启容器即自动应用
  ```

### 2.6 数据备份与恢复

SQLite 备份比 PostgreSQL 简单得多——本质就是复制一个文件。

```bash
# 在线备份（使用 sqlite3 .backup 命令，不停机，保证一致性）
docker compose exec api sqlite3 /data/psd-render.db ".backup '/data/backup-$(date +%Y%m%d).db'"

# 从容器复制到宿主机
docker cp psd-render-api:/data/backup-$(date +%Y%m%d).db ./backups/

# 或直接备份数据卷
docker run --rm -v psd-render-api_api-data:/data -v $(pwd):/backup \
    alpine tar czf /backup/sqlite-data-$(date +%Y%m%d).tar.gz -C /data .

# 恢复
docker cp ./backups/backup-20260720.db psd-render-api:/data/psd-render.db
docker compose restart api
```

建议配置定时备份任务（crontab）：

```cron
# 每天凌晨 3 点备份 SQLite
0 3 * * * cd /opt/psd-render-api && docker compose exec -T api sqlite3 /data/psd-render.db ".backup '/data/backup-$(date +\%Y\%m\%d).db'" && docker cp psd-render-api:/data/backup-$(date +\%Y\%m\%d).db /backup/
```

---

## 3. 渲染机侧部署（Electron Worker）

> 本节为概要说明，详细实现见 Worker 项目独立文档。

### 3.1 前置要求

- Windows 10/11 Pro 或 Enterprise（支持 COM 自动化）
- Photoshop 2024（25.x）已激活
- 已加入域或可访问 CVM（内网/公网均可）
- 用户已登录交互式会话（Worker 不在锁屏/服务账户环境运行）

### 3.2 安装步骤

1. **安装 Photoshop 2024**：从 Adobe Creative Cloud 安装（Worker 最低要求 PS 2024 / v25，低于此版本会拒绝注册）
2. **预装字体**：业务字体推荐走 Admin 后台「字体管理」上传并启用，Worker 空闲时自动同步安装；也可手动复制到 `C:\Windows\Fonts`
3. **安装 Electron Worker**：双击 `PsdRenderWorker-{version}-x64.exe`（NSIS 安装包），或使用 `PsdRenderWorker-{version}-portable.exe` 便携版免安装
   - 安装路径：`%PROGRAMDATA%\PsdRenderWorker\`
   - 安装时会请求 UAC 管理员权限（用于字体安装）
4. **配置后端地址**：启动 Worker，在界面「配置」面板将「后端 API 地址」改为管理后台实际地址（默认 `http://localhost:3000`）并点击「保存配置」；
   也可直接编辑 `%PROGRAMDATA%\PsdRenderWorker\config.json`（键名以 config.example.json 为准）：
   ```json
   {
     "backendUrl": "https://api.example.com",
     "heartbeatIntervalSec": 30,
     "claimMaxWaitSec": 20
   }
   ```
5. **激活连接（推荐：授权码模式）**：在管理后台「Worker 授权码」点击「生成授权码」，将 6 位授权码（如 `K9F-2X7`）输入 Worker 窗口的「Worker 授权激活」卡片，点击「激活并连接」即可自动注册上线（授权码 24 小时有效、仅可使用一次）
   - 备选（预共享密钥模式）：在后端配置 `WORKER_REGISTER_SECRET`，并将相同值填入 Worker `config.json` 的 `registerSecret` 字段；推荐使用授权码模式，无需分发长效密钥

### 3.3 验证 Worker 连接

1. 打开 Worker 状态窗口，确认"连接状态"显示"在线"
2. 在 Admin UI 查看 Worker 列表，确认节点已出现
3. 提交一个测试渲染任务，观察 Worker 是否领取并完成

---

## 4. Nginx 反向代理（可选但推荐）

规范建议："API 端口（3000）建议套一层 Nginx 处理 HTTPS 和限流。"

### 4.1 安装 Nginx

```bash
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx
```

### 4.2 申请 SSL 证书

```bash
sudo certbot --nginx -d api.example.com
```

### 4.3 配置 Nginx

复制示例配置：

```bash
sudo cp psd-render-api/deploy/nginx.conf.example /etc/nginx/conf.d/psd-render-api.conf
```

编辑 `/etc/nginx/conf.d/psd-render-api.conf`：
- 将 `api.example.com` 替换为实际域名
- 调整 `client_max_body_size`（建议 300m，与 MAX_PSD_SIZE_MB 匹配）
- 调整 Worker 内部接口的 IP 白名单（`allow` 行）

在 `/etc/nginx/nginx.conf` 的 `http {}` 块内添加限流区域：

```nginx
http {
    # ... 其他配置 ...
    limit_req_zone $binary_remote_addr zone=psd_api:10m rate=30r/s;
    limit_req_zone $binary_remote_addr zone=psd_upload:10m rate=5r/s;
}
```

测试并重载：

```bash
sudo nginx -t
sudo systemctl reload nginx
```

### 4.4 验证 Nginx

```bash
# HTTPS 验证
curl -sI https://api.example.com/health | head -5

# 限流验证（连续打 100 个请求到鉴权端点，应出现 429）
for i in $(seq 1 100); do curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer sk_live_xxx" https://api.example.com/v1/templates; done | sort | uniq -c
```

---

## 5. 健康检查与监控

### 5.1 健康检查端点（M11 提供）

- `GET /health`：综合健康检查，返回服务状态、数据库/存储/队列连通性（任一 down 返回 503）。供 Docker HEALTHCHECK 与负载均衡综合探测
- `GET /health/live`：存活探针，仅检查进程存活（不检查依赖），供 K8s livenessProbe 使用
- `GET /health/ready`：就绪探针，检查数据库与存储连通性（不检查队列），供 K8s readinessProbe 使用

> Worker 在线数请通过 `GET /metrics` 的 `workers_online` gauge 获取，或通过 `GET /admin/api/stats` 查询。

### 5.2 Docker HEALTHCHECK

`docker-compose.yml` 已配置 healthcheck，每 30s 探测 `/health`。查看状态：

```bash
docker compose ps
# STATUS 列显示 "healthy" / "unhealthy" / "starting"
```

### 5.3 告警通知（M10 提供）

配置 `ALERT_WEBHOOK_URL` 等环境变量后，告警触发时会自动推送通知：
- 通用 Webhook：POST JSON `{ title, message, severity, type, refId, triggeredAt }`
- 飞书机器人：`msg_type: 'text'`
- 钉钉机器人：`msgtype: 'text'`

按 `ALERT_MIN_SEVERITY` 过滤（默认 WARN 及以上才通知）。

告警类型：
- `worker_offline`：Worker 心跳超时
- `job_failed_rate`：任务失败率超阈值
- `queue_backlog`：队列堆积
- `ps_stuck`：PS 卡死
- `lease_expired`：租约超时

### 5.4 日志查看

```bash
# API 容器实时日志
docker compose logs -f api
```

---

## 6. 运维操作

### 6.1 升级版本

```bash
cd /opt/psd-render-api
git pull origin main

# 重新构建镜像
docker compose build

# 滚动重启
docker compose up -d

# 应用数据库 schema 变更（如有新迁移文件）
docker compose exec api npx prisma migrate deploy
```

### 6.2 查看运行状态

```bash
# 容器资源占用
docker stats psd-render-api

# SQLite 数据文件大小
docker compose exec api ls -lh /data/psd-render.db

# SQLite 表统计
docker compose exec api sqlite3 /data/psd-render.db \
  "SELECT name, (SELECT COUNT(*) FROM pragma_table_info(name)) AS cols FROM sqlite_master WHERE type='table';"
```

### 6.3 创建 API Key

通过 Admin UI（推荐）：
1. 访问 `http://内网IP:3000/admin`
2. 登录后进入"API Key 管理"
3. 创建新 Key，获取 `plaintextKey`（仅展示一次）

或通过 API：
```bash
# 用 admin session cookie 调用
curl -s -b "admin_session=$SESSION_TOKEN" \
     -X POST http://127.0.0.1:3000/admin/api/api-keys \
     -H "Content-Type: application/json" \
     -d '{"name":"业务方A","priority":5}' | jq
```

### 6.4 重启服务

```bash
# 重启 API
docker compose restart api

# 重启所有服务
docker compose restart

# 完全重建（保留数据卷）
docker compose down
docker compose up -d
```

### 6.5 清理存储

PSD/输入/结果文件按保留期自动清理（INPUT_RETENTION_DAYS=1, OUTPUT_RETENTION_DAYS=3）。

手动清理：

```bash
# 查看本地存储占用（STORAGE_BACKEND=local 时）
docker compose exec api du -sh /app/storage/

# 查看 COS 占用（STORAGE_BACKEND=cos 时，在腾讯云控制台查看）

# 强制清理过期文件（如有需要）
docker compose exec api node -e "
  import('./dist/services/storage/index.js').then(async m => {
    const s = m.getStorage();
    const r = await s.reapExpired?.();
    console.log('cleaned:', r);
  });
"
```

---

## 7. 故障排查

### 7.1 API 容器启动失败

```bash
# 查看启动日志
docker compose logs api | tail -100

# 常见错误：
# 1. "环境变量校验失败" → 检查 .env 文件
# 2. "PRAGMA 初始化跳过" → 检查 DATABASE_URL 是否为 file: 开头（SQLite 格式）
# 3. "Migration failed" → 检查 prisma/migrations 目录是否完整
```

### 7.2 Prisma migrate 失败

```bash
# 检查 DATABASE_URL
docker compose exec api sh -c 'echo $DATABASE_URL'
# 应输出 file:/data/psd-render.db

# 手动执行迁移
docker compose exec api npx prisma migrate deploy

# 查看迁移状态
docker compose exec api npx prisma migrate status

# 查看 SQLite 表
docker compose exec api sqlite3 /data/psd-render.db ".tables"
```

### 7.3 sharp 模块加载失败

```bash
# 验证 sharp
docker compose exec api node -e "const sharp = require('sharp'); console.log(sharp.versions);"

# 如果失败，可能 libvips 缺失，重新构建镜像
docker compose build --no-cache api
```

### 7.4 Worker 无法连接后端

1. 检查渲染机网络：`ping api.example.com`
2. 检查 443 端口：`Test-NetConnection api.example.com -Port 443`
3. 检查 Worker 配置文件 `config.json` 中 `backendUrl` 是否指向管理后台实际地址
4. 查看 Worker 日志：`%PROGRAMDATA%\PsdRenderWorker\logs\worker-YYYY-MM-DD.jsonl`

### 7.5 告警未触发通知

1. 检查 `ALERT_WEBHOOK_URL` 等环境变量是否配置
2. 调用 `GET /admin/api/alerts/channels` 验证渠道状态
3. 检查告警级别是否达到 `ALERT_MIN_SEVERITY`
4. 查看 API 日志中 `alertNotifier` 相关记录

### 7.6 任务卡在 QUEUED

1. 检查是否有在线 Worker：`GET /admin/api/workers`
2. 检查 Worker 能力是否匹配（PS 版本、字体清单）
3. 检查队列是否堆积：`GET /admin/api/jobs?status=QUEUED`
4. 检查告警：`GET /admin/api/alerts`

---

## 8. 数据库与队列设计说明

### 8.1 为何选择 SQLite

项目目标负载为 **10-20 任务并发**，单机部署，能接受稍微慢一点。SQLite 在此场景下完全胜任：

| 维度 | SQLite (WAL) | PostgreSQL | 项目需求 |
|------|-------------|------------|---------|
| 写入并发 | 单写者（毫秒级锁） | 多写者并行 | 10-20 并发，够用 |
| 写入吞吐 | ~1000 写/秒 | ~5000+ 写/秒 | 峰值 ~100 写/秒 |
| 读并发 | 多读者（不阻塞写） | 多读者 | 完全够用 |
| 部署复杂度 | 1 容器 | 1 容器 + 密码/备份/升级 | - |
| 备份 | 复制文件 | pg_dump | - |
| 资源占用 | ~10MB | ~80MB 空跑 | - |

### 8.2 SQLite 性能优化（已内置）

启动时自动启用 PRAGMA（见 `src/lib/prisma.ts`）：

```sql
PRAGMA journal_mode=WAL;          -- 读写不互相阻塞
PRAGMA busy_timeout=5000;         -- 写冲突时等待 5s 而非报错
PRAGMA synchronous=NORMAL;        -- WAL 下安全，比 FULL 快 2-3 倍
PRAGMA foreign_keys=ON;           -- 启用外键约束
```

### 8.3 并发安全

任务 claim 通过 DB 事务 + `updateMany WHERE status='QUEUED'` 条件更新防并发覆盖。
SQLite 默认 `SERIALIZABLE` 隔离级别，事务串行执行，**无竞态**（详见 `src/services/render-job/queue.ts` 注释）。

### 8.4 为何移除 Redis / BullMQ

原 BullMqQueue 类实际未真正使用 BullMQ 队列能力，仅检测 Redis 连接，claim 仍走 DB 事务。
项目目标负载下内存队列已足够，移除 Redis 简化部署。

### 8.5 何时应切回 PostgreSQL + Redis

如果未来出现以下信号，建议切回：

- 任务并发 > 100
- 心跳频率 < 5s 且 > 50 Worker
- 多机部署 API（第二台实例需要共享 DB）
- 数据量 > 5GB 或查询变慢

迁移成本低：schema 已保留 PostgreSQL 版本（`prisma/schema.postgres.prisma`），数据可导出 SQL 重新导入。

---

## 附录：相关文件

| 文件 | 说明 |
|------|------|
| `Dockerfile` | 多阶段构建镜像（builder + runner，SQLite 专用） |
| `docker-compose.yml` | API 单容器编排（SQLite + 内存队列） |
| `.dockerignore` | 构建上下文忽略清单 |
| `.env.example` | 环境变量模板（含全部 M1-M12 配置项） |
| `deploy/nginx.conf.example` | Nginx 反向代理配置示例 |
| `prisma/schema.prisma` | SQLite schema（唯一活跃版本） |
| `prisma/schema.sqlite.prisma` | SQLite schema 副本（switch-db.mjs 源文件） |
| `prisma/schema.postgres.prisma` | PostgreSQL schema（已不维护，仅作未来切换参考） |
| `prisma/migrations/` | SQLite 迁移文件 |
| `prisma/migrations-pg/` | PostgreSQL 迁移文件（已不维护） |
| `scripts/switch-db.mjs` | 数据库 schema 切换脚本（仅 dev 用） |
