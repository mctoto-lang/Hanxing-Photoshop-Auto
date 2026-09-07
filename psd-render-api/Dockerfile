# PSD 渲染服务平台 - 后端镜像（第三期改造：纯 SQLite 部署）
#
# 多阶段构建：
#   1. builder: 安装依赖 + 编译 TypeScript
#   2. runner: 仅复制 dist + prod 依赖，最小化镜像体积
#
# 关键边界：本镜像仅运行 API、队列、数据库逻辑；不安装、不启动 Photoshop。
# Photoshop 只在 Windows 渲染机的交互式用户会话中由 Electron Worker 调用。
#
# 基础镜像选 bookworm-slim 而非 alpine：sharp 是原生模块，alpine 需额外编译。
#
# 第三期改造说明：
#   - 数据库改为 SQLite（WAL 模式 + busy_timeout），无需 PostgreSQL 容器
#   - 队列改为内存队列，无需 Redis 容器
#   - 部署从 3 容器（api + postgres + redis）简化为 1 容器
#   - SQLite 数据文件挂载到 /data 卷，备份变为"复制一个 .db 文件"
#
# 国内镜像源说明：
#   - apt 替换为阿里云 Debian bookworm 源
#   - npm registry 设为 npmmirror（淘宝镜像）
#   - Prisma 引擎二进制通过 npmmirror binary 镜像下载
#   - 基础镜像可通过 NODE_IMAGE 指向企业 Harbor、ACR 或 TCR 缓存

# ============== Stage 1: builder ==============
# node:22 而非 node:20：pnpm@11 要求 node >= 22.13（ERR_UNKNOWN_BUILTIN_MODULE），
# 与开发环境（Node 22 + pnpm 11）工具链对齐；应用 engines 声明 node >= 20 兼容
ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE} AS builder

WORKDIR /app

# 切换 apt 为阿里云 Debian bookworm 源（国内构建加速）
# bookworm-slim 默认不含 /etc/apt/sources.list，源在 /etc/apt/sources.list.d/debian.sources
# 替换后必须校验是否真的命中 aliyun，避免 sources 结构变化导致 sed 静默失败、回退到默认国外源
RUN sed -i 's|deb.debian.org|mirrors.aliyun.com|g; s|security.debian.org|mirrors.aliyun.com|g' \
    /etc/apt/sources.list.d/debian.sources 2>/dev/null \
    || sed -i 's|deb.debian.org|mirrors.aliyun.com|g; s|security.debian.org|mirrors.aliyun.com|g' \
    /etc/apt/sources.list 2>/dev/null \
    || true \
    && grep -rq 'mirrors.aliyun.com' /etc/apt/sources.list.d /etc/apt/sources.list 2>/dev/null \
    || { echo '❌ apt 源替换失败：未检测到 mirrors.aliyun.com，请检查 Debian 版本与 sources 文件结构'; exit 1; }

# 系统依赖：sharp 原生模块编译需要
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# 配置 npm 国内镜像源
# 注:Prisma 引擎镜像通过 PRISMA_ENGINES_MIRROR 环境变量配置,
#     新版 npm(10.x+)不再接受 `npm config set prisma_engines_mirror` 命令
RUN npm config set registry https://registry.npmmirror.com

# 安装 pnpm（与开发环境大版本一致，pnpm-lock.yaml 为 lockfileVersion 9.0）
RUN npm install -g pnpm@11

# pnpm 的包下载走国内镜像（npm_config_* 环境变量对 pnpm 生效；
# 不用 `pnpm config set`：检测到 pnpm-workspace.yaml 时会写入该文件污染构建上下文）
ENV npm_config_registry=https://registry.npmmirror.com

# Prisma 引擎二进制镜像(npmmirror 淘宝镜像)
# 提前到 pnpm install 之前:@prisma/client 的 postinstall 脚本会下载引擎,
# 必须在此之前生效,否则会走默认国外源导致国内构建超时
ENV PRISMA_ENGINES_MIRROR=https://registry.npmmirror.com/-/binary/prisma

# 先复制依赖清单利用 Docker 层缓存
# 强制要求 pnpm-lock.yaml / pnpm-workspace.yaml 必须存在（去掉通配符），保证可重现构建
# pnpm-workspace.yaml 承载 allowBuilds（sharp/prisma/esbuild 原生构建白名单）
# 与 nodeLinker: hoisted（npm 式平铺布局，符号链接布局下 @prisma/client
# 会解析到虚拟商店的 .prisma stub，导致类型退化为 any、运行时抛错）
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY prisma ./prisma
COPY scripts ./scripts

# 安装全部依赖（含 devDependencies，用于编译）
# 仅使用 --frozen-lockfile 保证可重现构建，禁止静默改写锁文件
# postinstall 钩子自动执行 prisma generate（prisma/ 已复制、PRISMA_ENGINES_MIRROR 已生效）
RUN pnpm install --frozen-lockfile

# 第三期改造：schema.prisma 默认就是 SQLite 版本，无需切换
# 复制源码并编译
COPY tsconfig.json ./
COPY src ./src

RUN pnpm run build

# 生成 Prisma Client（基于 SQLite schema）
# postinstall 已生成过，此处幂等执行兜底；PRISMA_ENGINES_MIRROR 已在上方设置
RUN ./node_modules/.bin/prisma generate

# ============== Stage 2: runner ==============
FROM ${NODE_IMAGE} AS runner

WORKDIR /app

# 切换 apt 为阿里云 Debian bookworm 源
# 同 builder 阶段：替换后必须 grep 校验，避免静默失败
RUN sed -i 's|deb.debian.org|mirrors.aliyun.com|g; s|security.debian.org|mirrors.aliyun.com|g' \
    /etc/apt/sources.list.d/debian.sources 2>/dev/null \
    || sed -i 's|deb.debian.org|mirrors.aliyun.com|g; s|security.debian.org|mirrors.aliyun.com|g' \
    /etc/apt/sources.list 2>/dev/null \
    || true \
    && grep -rq 'mirrors.aliyun.com' /etc/apt/sources.list.d /etc/apt/sources.list 2>/dev/null \
    || { echo '❌ apt 源替换失败：未检测到 mirrors.aliyun.com，请检查 Debian 版本与 sources 文件结构'; exit 1; }

# 运行时依赖：sharp 在 bookworm-slim 上需要 libvips
# 注：node 22 slim 镜像通常已预装 libvips，若缺可显式安装
# SQLite 是 Node 内置模块 better-sqlite3 的替代，Prisma 用 @prisma/client 自带驱动，
# 不需要额外系统依赖；openssl 保留用于加密相关操作
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl \
    sqlite3 \
    && rm -rf /var/lib/apt/lists/*

# P0-4：创建非 root 用户运行容器，降低容器逃逸/提权风险
RUN groupadd --system --gid 1001 psd \
    && useradd --system --uid 1001 --gid psd --no-create-home --home-dir /app --shell /usr/sbin/nologin psd

# 配置 npm 国内镜像源 + 安装 pnpm（runner 阶段独立配置）
RUN npm config set registry https://registry.npmmirror.com \
    && npm install -g pnpm@11

# pnpm 包下载走国内镜像（同 builder 阶段）
ENV npm_config_registry=https://registry.npmmirror.com

# Prisma 引擎镜像(同 builder 阶段)
# runner 阶段 pnpm install --prod 安装 @prisma/client 时会触发 postinstall 下载引擎,
# 必须配置镜像源,否则走默认国外源易超时/ECONNRESET
ENV PRISMA_ENGINES_MIRROR=https://registry.npmmirror.com/-/binary/prisma

# 仅复制生产依赖清单
# 强制要求 pnpm-lock.yaml / pnpm-workspace.yaml 必须存在
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# prisma/ 必须在安装前复制：根 postinstall 钩子（prisma generate）需要 schema
COPY prisma ./prisma

# 仅安装生产依赖
# prisma CLI 位于 dependencies（启动命令 migrate deploy 需要），--prod 会保留；
# nodeLinker: hoisted 使 node_modules 为平铺真实目录，跨 stage 复制安全
RUN pnpm install --frozen-lockfile --prod

# 复制构建产物
COPY --from=builder /app/dist ./dist
# 从 builder 复制 prisma 目录（schema.prisma + migrations/，migrate deploy 需要）
# Prisma Client 由上方 postinstall 在本 stage 自行生成（引擎二进制随生成产物落盘）
COPY --from=builder /app/prisma ./prisma

# 第三期改造：创建 SQLite 数据目录 /data（与 docker-compose 卷挂载点对应）
#   目录归属非 root 用户，确保容器以 psd 启动后可读写
#   同时创建本地存储目录（STORAGE_BACKEND=local 时使用）与日志目录
RUN mkdir -p /data /app/storage /app/logs \
    && chown -R psd:psd /app /data

# 环境变量默认值（生产建议通过 docker-compose / k8s env 覆盖）
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    LOG_LEVEL=info \
    STORAGE_BACKEND=local \
    LOCAL_STORAGE_DIR=/app/storage \
    DATABASE_URL="file:/data/psd-render.db" \
    QUEUE_BACKEND=memory

# 健康检查由 docker-compose.yml 定义（更易维护，避免与 compose 重复）
# 如需在裸 docker run 使用，可在此处恢复 HEALTHCHECK 指令

EXPOSE 3000

# P0-4：以非 root 用户运行
USER psd

# 启动命令：
#   1. prisma migrate deploy —— 应用 prisma/migrations 中所有 SQLite 迁移
#      首次部署创建所有表；增量升级应用后续新增的迁移文件
#      直接调用本地 node_modules/.bin/prisma，避免 npx 运行时联网检查更新
#   2. node dist/server.js —— 启动 Fastify 服务（启动时自动初始化 SQLite PRAGMA）
CMD ["sh", "-c", "./node_modules/.bin/prisma migrate deploy && node dist/server.js"]
