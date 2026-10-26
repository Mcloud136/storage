# MCloud 项目介绍

## 项目定位

MCloud 是 [K-Vault](https://github.com/katelya77/K-Vault) 的 fork，目标是在 Cloudflare 免费额度内提供稳定的图片/文件托管，并保持与旧版 KV 数据、直链、会话、Token 的完全兼容。

v2 使用 **Cloudflare Workers + Static Assets** 单运行时，服务端为 TypeScript + Hono，前端为 Vue 3 + Element Plus。

## 技术架构

### 前端

- 根目录 `public/` 静态页面：`index.html`、`admin.html`、`gallery.html`、`webdav.html`、`login.html`、`preview.html`、`block-img.html`、`whitelist-on.html`
- Vue 3 + Element Plus，依赖本地化到 `public/vendor/`，不依赖公共 CDN
- 上传、压缩、预览等交互在浏览器完成；大文件分片上传

### 后端

- Hono on Workers，入口 `src/index.ts`
- `run_worker_first` 接管 `/api/*`、`/upload`、`/file/*`、`/s/*`、`/share/*`，其余路径由静态资源处理
- 存储抽象：Telegram、HuggingFace、GitHub、WebDAV
- KV 绑定 `img_url` 保存元数据、会话、Token、分享、UI 配置与分片状态

### 数据与兼容

- 新记录写入裸键；读取兼容 `img:`、`vid:`、`aud:`、`doc:`、`r2:`、`s3:`、`discord:`、`hf:`、`webdav:`、`github:` 前缀
- Telegram 支持 `tgs_` 签名直链与多级密钥回退
- 旧 Cookie `k_vault_session` / `katelya_session`、旧 API Token 继续有效

## 已移除

- Docker/Hono + SQLite 自托管线
- R2、S3、Discord 存储后端
- 作者内置 Sentry 遥测
- 两个孤立后台页 `admin-imgtc.html`、`admin-waterfall.html`

## 相关文档

- [README.md](README.md)：部署与配置
- [docs/openapi.yaml](docs/openapi.yaml)：API 契约
- [docs/agent-integration.md](docs/agent-integration.md)：Agent / 脚本接入
