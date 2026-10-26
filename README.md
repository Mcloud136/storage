<div align="center">

<img src="logo.png" alt="K-Vault Logo" width="140">

# MCloud

> 基于 Cloudflare Workers 的免费文件托管服务，文件本体存放在 Telegram / HuggingFace / GitHub / WebDAV，元数据放在 KV

[English](README-EN.md) | **中文**

</div>

---

## 项目说明

MCloud 是 [K-Vault](https://github.com/katelya77/K-Vault) 的 fork，继续使用 Cloudflare 免费栈，但把运行时从 **Pages Functions 迁移到 Workers + Static Assets**，并用 TypeScript + Hono 重写了服务端。

当前分支（`v2/m1-scaffold`）为 v2 实现，生产环境在切换前仍由 Pages 分支提供服务。

### 与旧版的差异

- 运行时：Cloudflare Workers + 静态资源，不再依赖 Pages Functions。
- 语言：TypeScript + Hono，前端升级到 Vue 3 + Element Plus。
- 存储后端：保留 Telegram、HuggingFace、GitHub、WebDAV；**移除 R2、S3、Discord**。
- 移除 Docker/Hono + SQLite 自托管线。
- 移除作者内置的 Sentry 遥测；Webhook 密钥与后台鉴权改为 fail-closed。

### 功能

- 图片、视频、音频、文档上传与在线预览（图片 / 视频 / 音频 / PDF / docx / txt）
- 直链访问、Range 下载、HEAD、`/s/:slug` 短链
- Telegram 签名直链（`tgs_...`）与 Webhook 自动回链
- 分片上传（5MB 分片，单文件上限 100MB）
- 图片压缩/格式转换（浏览器端）
- 访客上传（可配置大小与每日次数）
- API Token（scopes / policies / 幂等 / 限流）
- 后台管理：文件列表、目录、移动、重命名、删除、Token、UI 配置、状态检查
- 旧数据兼容：裸键与 `img:`/`vid:`/`aud:`/`doc:`/`hf:`/`webdav:`/`github:`/`r2:`/`s3:`/`discord:` 前缀读取，旧会话 Cookie 与旧 Token 继续有效

---

## 架构

```text
浏览器 / API 客户端
        │
        ▼
Cloudflare Worker (Hono, TypeScript)
  ├─ /api/*        鉴权、状态、上传、管理、Token、Webhook
  ├─ /file/*       下载、Range、分享、签名直链
  ├─ /s/*          短链
  └─ ASSETS        public/ 静态页面与本地 vendor 资源
        │
        ├─ KV (img_url)          文件元数据、会话、Token、分享、UI 配置
        ├─ Telegram Bot API      文件本体
        ├─ HuggingFace Datasets  文件本体
        ├─ GitHub Releases/Contents
        └─ WebDAV                PUT/GET/DELETE/MKCOL
```

KV 绑定名必须是 `img_url`，兼容现有生产数据。

---

## 部署

### 前置条件

- Node.js 20+
- Cloudflare 账户
- 一个 KV 命名空间（绑定名 `img_url`）

### 1. 安装依赖

```bash
npm install
```

### 2. 创建并绑定 KV

```bash
npx wrangler kv namespace create img_url
```

把输出的 `id` 填入 `wrangler.jsonc` 的 `kv_namespaces[0].id`。自定义域在 `routes` 中配置；没有自定义域时删除 `routes`，使用 `*.workers.dev`。

### 3. 配置变量与密钥

后台账号：

```bash
npx wrangler secret put BASIC_USER
npx wrangler secret put BASIC_PASS
```

Telegram：

```bash
npx wrangler secret put TG_Bot_Token
npx wrangler secret put TG_Chat_ID
npx wrangler secret put TG_WEBHOOK_SECRET
npx wrangler secret put FILE_URL_SECRET
```

HuggingFace / GitHub / WebDAV 按需配置（见下方“存储后端”）。

> 未配置 `BASIC_USER`/`BASIC_PASS` 时，后台与管理 API 默认拒绝访问（fail-closed）。

### 4. 部署

```bash
npm run deploy
```

部署后访问 `/api/health` 与 `/api/status` 检查绑定和后端状态。

### 5. Telegram Webhook（可选）

```bash
curl -X POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d "{\"url\":\"https://你的域名/api/telegram/webhook\",\"secret_token\":\"<TG_WEBHOOK_SECRET>\",\"allowed_updates\":[\"message\",\"channel_post\"]}"
```

Bot 需要加入目标频道/群并有发言权限。`getWebhookInfo` 可用于排查投递状态。

---

## 存储后端

### Telegram

| 变量 | 说明 |
| :--- | :--- |
| `TG_Bot_Token` / `TG_BOT_TOKEN` | Bot Token |
| `TG_Chat_ID` / `TG_CHAT_ID` | 频道或群 ID |
| `TG_WEBHOOK_SECRET` | Webhook 校验密钥 |
| `PUBLIC_BASE_URL` | 生成回链使用的公网地址 |
| `CUSTOM_BOT_API_URL` | 自部署 Bot API 地址（可选） |
| `TELEGRAM_LINK_MODE` | `signed` 启用签名直链 |
| `FILE_URL_SECRET` | 签名密钥（缺省回退 Bot Token） |
| `TELEGRAM_METADATA_MODE` | `off` 跳过 Telegram 元数据写入 |
| `TG_UPLOAD_NOTIFY` | 网页上传成功后发送通知消息 |

网页上传单文件上限 20MB（Cloudflare 请求体限制）；更大的文件请走 WebDAV 或直接在 Telegram 客户端发送后由 Webhook 回链。

### HuggingFace

| 变量 | 说明 |
| :--- | :--- |
| `HF_TOKEN` | 具有写权限的 Token |
| `HF_REPO` | Dataset 仓库 ID（`owner/name`） |

### GitHub

| 变量 | 说明 |
| :--- | :--- |
| `GITHUB_TOKEN` | 仓库写权限 Token |
| `GITHUB_REPO` | `owner/repo` |
| `GITHUB_MODE` | `releases`（默认）或 `contents` |
| `GITHUB_PREFIX` | 仓库内路径前缀（可选） |
| `GITHUB_BRANCH` | contents 模式分支（可选） |
| `GITHUB_RELEASE_TAG` | releases 模式固定标签（可选） |
| `GITHUB_API_BASE` | GitHub API 基址（可选） |

### WebDAV

| 变量 | 说明 |
| :--- | :--- |
| `WEBDAV_BASE_URL` | WebDAV 根地址，不带结尾 `/` |
| `WEBDAV_USERNAME` / `WEBDAV_PASSWORD` | Basic 认证 |
| `WEBDAV_BEARER_TOKEN` / `WEBDAV_TOKEN` | Bearer Token（二选一） |
| `WEBDAV_ROOT_PATH` | 根目录前缀（可选） |

服务端需要支持 `PUT` / `GET` / `HEAD` / `DELETE` / `MKCOL` 与 Range。

---

## 其他配置

| 变量 | 说明 |
| :--- | :--- |
| `GUEST_UPLOAD` | `true` 开启访客上传 |
| `GUEST_MAX_FILE_SIZE` | 访客单文件上限（字节） |
| `GUEST_DAILY_LIMIT` | 访客每日上传次数 |
| `API_CORS_ORIGINS` | API v1 允许的来源，逗号分隔 |
| `WhiteList_Mode` | 旧版白名单模式兼容开关 |

---

## 本地开发与测试

```bash
npm run dev          # wrangler dev
npm test             # vitest（43 个用例）
npm run typecheck    # tsc --noEmit
npm run inventory    # 只读盘点 KV 键分布
```

本地测试需要 KV 绑定；首次 `npm run dev` 会在本地创建模拟 KV。

---

## 使用限制

- Workers 免费版：10ms CPU / 请求、128MB 内存、50 个子请求。
- 请求体上限 100MB；分片上传按 5MB 切分，complete 阶段在 Worker 内存合并，建议单文件不超过 90MB。
- Telegram 网页上传 20MB；HuggingFace 普通上传约 35MB；GitHub contents 模式建议不超过 20MB。
- KV 免费额度：读 10 万次/天、写 1000 次/天。分片上传会消耗多次写入，`/api/status` 会返回当前限制。
- 签名直链不读取 KV，因此不受黑白名单/删除状态影响；需要可撤销的分享请使用普通 `/file/:id` 或分享链接。

---

## API

- API Token 在后台“API Token 管理”创建，格式 `kvault_<id>_<secret>`。
- 上传：`POST /api/v1/upload`（`multipart/form-data`）
- URL 导入：`POST /api/v1/import`
- 列表：`GET /api/v1/files`
- 详细契约见 [docs/openapi.yaml](docs/openapi.yaml) 与 [docs/agent-integration.md](docs/agent-integration.md)。

---

## 许可

MIT，见 [LICENSE](LICENSE)。上游项目：[katelya77/K-Vault](https://github.com/katelya77/K-Vault)。
