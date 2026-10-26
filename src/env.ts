export interface Env {
  img_url: KVNamespace;
  ASSETS: Fetcher;

  BASIC_USER?: string;
  BASIC_PASS?: string;
  GUEST_UPLOAD?: string;
  GUEST_MAX_FILE_SIZE?: string;
  GUEST_DAILY_LIMIT?: string;

  TG_Bot_Token?: string;
  TG_BOT_TOKEN?: string;
  TG_Chat_ID?: string;
  TG_CHAT_ID?: string;
  TG_WEBHOOK_SECRET?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  CUSTOM_BOT_API_URL?: string;
  PUBLIC_BASE_URL?: string;
  TELEGRAM_LINK_MODE?: string;
  MINIMIZE_KV_WRITES?: string;
  TELEGRAM_METADATA_MODE?: string;
  TELEGRAM_SKIP_METADATA?: string;
  TG_UPLOAD_NOTIFY?: string;
  TELEGRAM_UPLOAD_NOTIFY?: string;
  FILE_URL_SECRET?: string;
  TG_FILE_URL_SECRET?: string;

  HF_TOKEN?: string;
  HF_REPO?: string;

  WEBDAV_BASE_URL?: string;
  WEBDAV_USERNAME?: string;
  WEBDAV_PASSWORD?: string;
  WEBDAV_BEARER_TOKEN?: string;
  WEBDAV_TOKEN?: string;
  WEBDAV_ROOT_PATH?: string;

  GITHUB_TOKEN?: string;
  GITHUB_REPO?: string;
  GITHUB_MODE?: string;
  GITHUB_PREFIX?: string;
  GITHUB_BRANCH?: string;
  GITHUB_RELEASE_TAG?: string;
  GITHUB_API_BASE?: string;

  API_CORS_ORIGINS?: string;
  WhiteList_Mode?: string;
}
