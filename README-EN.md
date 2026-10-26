<div align="center">

<img src="logo.png" alt="K-Vault Logo" width="140">

# MCloud

> Free file hosting on Cloudflare Workers. File bodies live in Telegram / HuggingFace / GitHub / WebDAV; metadata lives in KV.

**English** | [中文](README.md)

</div>

---

## About

MCloud is a fork of [K-Vault](https://github.com/katelya77/K-Vault) that keeps the Cloudflare free stack but moves the runtime from Pages Functions to **Workers + Static Assets**, rewritten in TypeScript + Hono.

The `v2/m1-scaffold` branch contains the v2 implementation; production still runs the Pages branch until cutover.

### Changes from upstream

- Runtime: Cloudflare Workers + static assets.
- Server: TypeScript + Hono; frontend upgraded to Vue 3 + Element Plus.
- Storage backends: Telegram, HuggingFace, GitHub and WebDAV. R2, S3 and Discord were removed.
- The Docker/Hono + SQLite self-hosting line was removed.
- Author-provided Sentry telemetry was removed; admin auth and webhook checks are fail-closed.

### Features

- Upload and preview images, video, audio and documents (PDF / docx / txt included).
- Direct file links, Range requests, HEAD, `/s/:slug` short links.
- Telegram signed links (`tgs_...`) and webhook auto-replies.
- Chunked upload (5MB chunks, 100MB per-file limit).
- Browser-side image compression and format conversion.
- Guest uploads with size and daily-count limits.
- API tokens with scopes, policies, idempotency and rate limits.
- Admin console: files, folders, move, rename, delete, tokens, UI config, status.
- Legacy compatibility: bare and prefixed KV keys, old session cookies and old tokens keep working.

---

## Architecture

```text
Browser / API client
        │
        ▼
Cloudflare Worker (Hono, TypeScript)
  ├─ /api/*        auth, status, upload, admin, tokens, webhook
  ├─ /file/*       download, Range, shares, signed links
  ├─ /s/*          short links
  └─ ASSETS        public/ pages and local vendor assets
        │
        ├─ KV (img_url)          metadata, sessions, tokens, shares, UI config
        ├─ Telegram Bot API      file bodies
        ├─ HuggingFace Datasets  file bodies
        ├─ GitHub Releases/Contents
        └─ WebDAV                PUT/GET/DELETE/MKCOL
```

The KV binding name must be `img_url` for compatibility with existing data.

---

## Deploy

Requirements: Node.js 20+, a Cloudflare account and a KV namespace.

```bash
npm install
npx wrangler kv namespace create img_url
# put the returned id into wrangler.jsonc -> kv_namespaces[0].id
npx wrangler secret put BASIC_USER
npx wrangler secret put BASIC_PASS
npx wrangler secret put TG_Bot_Token
npx wrangler secret put TG_Chat_ID
npx wrangler secret put TG_WEBHOOK_SECRET
npx wrangler secret put FILE_URL_SECRET
npm run deploy
```

Add a custom domain in `wrangler.jsonc` under `routes`, or remove `routes` to use `*.workers.dev`.

If `BASIC_USER` / `BASIC_PASS` are not set, admin pages and admin APIs reject all requests.

### Telegram webhook

```bash
curl -X POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d "{\"url\":\"https://your-domain/api/telegram/webhook\",\"secret_token\":\"<TG_WEBHOOK_SECRET>\",\"allowed_updates\":[\"message\",\"channel_post\"]}"
```

The bot must be a member with posting rights in the target channel or group.

---

## Storage backends

### Telegram

`TG_Bot_Token`, `TG_Chat_ID`, `TG_WEBHOOK_SECRET`, `PUBLIC_BASE_URL`, optional `CUSTOM_BOT_API_URL`, `TELEGRAM_LINK_MODE=signed`, `FILE_URL_SECRET`, `TELEGRAM_METADATA_MODE=off`, `TG_UPLOAD_NOTIFY`.

Browser uploads are limited to 20MB by the Cloudflare request body limit. Use WebDAV or send files directly in Telegram for larger uploads.

### HuggingFace

`HF_TOKEN` and `HF_REPO` (dataset repository id).

### GitHub

`GITHUB_TOKEN`, `GITHUB_REPO`, optional `GITHUB_MODE` (`releases` or `contents`), `GITHUB_PREFIX`, `GITHUB_BRANCH`, `GITHUB_RELEASE_TAG`, `GITHUB_API_BASE`.

### WebDAV

`WEBDAV_BASE_URL`, `WEBDAV_USERNAME` / `WEBDAV_PASSWORD` or `WEBDAV_BEARER_TOKEN` / `WEBDAV_TOKEN`, optional `WEBDAV_ROOT_PATH`. The server must support `PUT`, `GET`, `HEAD`, `DELETE`, `MKCOL` and Range.

### Other settings

`GUEST_UPLOAD`, `GUEST_MAX_FILE_SIZE`, `GUEST_DAILY_LIMIT`, `API_CORS_ORIGINS`, `WhiteList_Mode`.

---

## Development

```bash
npm run dev        # wrangler dev
npm test           # vitest
npm run typecheck  # tsc --noEmit
npm run inventory  # read-only KV key inventory
```

---

## Limits

- Workers free plan: 10ms CPU per request, 128MB memory, 50 subrequests.
- Request body limit: 100MB. Chunked uploads use 5MB parts and are merged in memory; keep files below ~90MB.
- Telegram browser upload: 20MB. HuggingFace regular upload: ~35MB. GitHub contents: keep below 20MB.
- KV free tier: 100k reads/day, 1k writes/day. Chunked uploads consume several writes.
- Signed links bypass KV, so they ignore block lists and deletion state. Use normal `/file/:id` links when revocation matters.

---

## License

MIT. See [LICENSE](LICENSE). Upstream: [katelya77/K-Vault](https://github.com/katelya77/K-Vault).
