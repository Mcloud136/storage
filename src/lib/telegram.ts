import type { Env } from '../env';

const DEFAULT_TELEGRAM_API_BASE = 'https://api.telegram.org';

const MIME_EXTENSION_MAP: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/flac': 'flac',
  'audio/aac': 'aac',
  'audio/mp4': 'm4a',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'application/x-7z-compressed': '7z',
  'application/x-rar-compressed': 'rar',
  'text/plain': 'txt',
  'application/json': 'json',
};

export function getTelegramToken(env: Env): string {
  return String(env.TG_Bot_Token || env.TG_BOT_TOKEN || '').trim();
}

export function getTelegramChatId(env: Env): string {
  return String(env.TG_Chat_ID || env.TG_CHAT_ID || '').trim();
}

export function getTelegramApiBase(env: Env): string {
  const raw = String(env.CUSTOM_BOT_API_URL || '').trim();
  if (!raw) return DEFAULT_TELEGRAM_API_BASE;
  try {
    return new URL(raw).toString().replace(/\/+$/, '');
  } catch {
    return DEFAULT_TELEGRAM_API_BASE;
  }
}

export function buildTelegramBotApiUrl(env: Env, method: string): string {
  const token = getTelegramToken(env);
  const normalizedMethod = String(method || '').replace(/^\/+/, '');
  return `${getTelegramApiBase(env)}/bot${token}/${normalizedMethod}`;
}

export function buildTelegramFileUrl(env: Env, filePath: string): string {
  const token = getTelegramToken(env);
  const normalizedPath = String(filePath || '').replace(/^\/+/, '');
  return `${getTelegramApiBase(env)}/file/bot${token}/${normalizedPath}`;
}

export function getTelegramUploadMethodAndField(contentType = ''): { method: string; field: string } {
  const type = String(contentType || '').toLowerCase();
  if (type.startsWith('image/')) return { method: 'sendDocument', field: 'document' };
  if (type.startsWith('audio/')) return { method: 'sendAudio', field: 'audio' };
  if (type.startsWith('video/')) return { method: 'sendVideo', field: 'video' };
  return { method: 'sendDocument', field: 'document' };
}

export interface TelegramApiResult {
  ok?: boolean;
  result?: {
    message_id?: number;
    file_id?: string;
    username?: string;
    first_name?: string;
    photo?: Array<{ file_id?: string; file_size?: number }>;
    document?: { file_id?: string };
    video?: { file_id?: string };
    audio?: { file_id?: string };
    voice?: { file_id?: string };
    sticker?: { file_id?: string };
    animation?: { file_id?: string };
    video_note?: { file_id?: string };
    file_path?: string;
  };
  description?: string;
  parameters?: { retry_after?: number };
}

export function pickTelegramFileId(responseData: TelegramApiResult | null | undefined): string | null {
  if (!responseData?.ok || !responseData.result) return null;
  const result = responseData.result;

  if (Array.isArray(result.photo) && result.photo.length) {
    return (
      result.photo.reduce((previous, current) =>
        (previous?.file_size || 0) > (current?.file_size || 0) ? previous : current
      )?.file_id || null
    );
  }

  return (
    result.document?.file_id ||
    result.video?.file_id ||
    result.audio?.file_id ||
    result.voice?.file_id ||
    result.sticker?.file_id ||
    result.animation?.file_id ||
    result.video_note?.file_id ||
    null
  );
}

export function guessExtensionFromMimeType(mimeType: string, fallback = 'bin'): string {
  const normalized = String(mimeType || '').split(';')[0].trim().toLowerCase();
  return MIME_EXTENSION_MAP[normalized] || fallback;
}

export function sanitizeFileExtension(extension: string, fallback = 'bin'): string {
  const normalized = String(extension || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  if (!normalized) return fallback;
  return normalized.slice(0, 10);
}

export function getFileExtension(fileName: string, mimeType: string, fallback = 'bin'): string {
  const name = String(fileName || '');
  const fromName = name.split('.').pop()?.toLowerCase();
  if (fromName && fromName !== name.toLowerCase()) {
    return sanitizeFileExtension(fromName, fallback);
  }
  if (name.includes('.')) {
    return sanitizeFileExtension(fromName || '', fallback);
  }
  return sanitizeFileExtension(guessExtensionFromMimeType(mimeType, fallback), fallback);
}

function base64UrlEncode(input: string | Uint8Array): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecodeToBytes(input: string): Uint8Array {
  const base64 = String(input || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4 || 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function base64UrlDecodeToString(input: string): string {
  return new TextDecoder().decode(base64UrlDecodeToBytes(input));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let index = 0; index < a.length; index += 1) {
    mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return mismatch === 0;
}

async function signPayload(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(payload)
  );
  return base64UrlEncode(new Uint8Array(signature));
}

function getFileLinkSecrets(env: Env): string[] {
  const candidates = [
    env.FILE_URL_SECRET,
    env.TG_FILE_URL_SECRET,
    getTelegramToken(env),
  ];

  return [
    ...new Set(
      candidates
        .map((item) => (item == null ? '' : String(item).trim()))
        .filter(Boolean)
    ),
  ];
}

export function shouldUseSignedTelegramLinks(env: Env): boolean {
  if (String(env.TELEGRAM_LINK_MODE || '').toLowerCase() === 'signed') return true;
  return env.MINIMIZE_KV_WRITES === 'true';
}

export function shouldWriteTelegramMetadata(env: Env): boolean {
  const metadataMode = String(env.TELEGRAM_METADATA_MODE || '').trim().toLowerCase();
  if (['off', 'none', 'disable', 'disabled', 'minimal'].includes(metadataMode)) return false;
  if (['on', 'full', 'always', 'enable', 'enabled'].includes(metadataMode)) return true;

  const skipMetadata = String((env as Env & { TELEGRAM_SKIP_METADATA?: string }).TELEGRAM_SKIP_METADATA || '')
    .trim()
    .toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(skipMetadata)) return false;

  return true;
}

function isFlagEnabled(value: string | undefined, defaultValue: boolean): boolean {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return defaultValue;
  if (['1', 'true', 'yes', 'on', 'enable', 'enabled'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off', 'disable', 'disabled'].includes(normalized)) return false;
  return defaultValue;
}

export function shouldNotifyTelegramUpload(env: Env): boolean {
  return isFlagEnabled(env.TG_UPLOAD_NOTIFY ?? env.TELEGRAM_UPLOAD_NOTIFY, true);
}

function normalizeBaseUrl(raw: string | undefined): string {
  if (!raw) return '';
  try {
    return new URL(String(raw)).toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

export function buildTelegramDirectLink(
  env: Env,
  directId: string,
  fallbackOrigin = ''
): string {
  const base = normalizeBaseUrl(env.PUBLIC_BASE_URL) || normalizeBaseUrl(fallbackOrigin);
  return base ? `${base}/file/${directId}` : `/file/${directId}`;
}

export interface SignedTelegramFileMeta {
  version: number;
  fileId: string;
  fileExtension: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  timestamp: number;
  messageId: number | null;
}

export async function createSignedTelegramFileId(
  {
    fileId,
    fileExtension,
    fileName,
    mimeType,
    fileSize,
    messageId,
  }: {
    fileId: string;
    fileExtension: string;
    fileName: string;
    mimeType: string;
    fileSize: number;
    messageId?: number | null;
  },
  env: Env
): Promise<string> {
  const extension = sanitizeFileExtension(fileExtension || 'bin');
  const payloadObject = {
    v: 1,
    f: String(fileId || ''),
    e: extension,
    n: truncateFileName(fileName || ''),
    m: String(mimeType || ''),
    s: Number(fileSize || 0),
    t: Date.now(),
    mid: messageId ? Number(messageId) : undefined,
  };
  const payload = base64UrlEncode(JSON.stringify(payloadObject));
  const [primarySecret] = getFileLinkSecrets(env);
  if (!primarySecret) {
    throw new Error('FILE_URL_SECRET or TG_Bot_Token is required for signed links.');
  }
  const signature = await signPayload(payload, primarySecret);
  return `tgs_${payload}.${signature}.${extension}`;
}

export async function parseSignedTelegramFileId(
  id: string,
  env: Env
): Promise<SignedTelegramFileMeta | null> {
  const match = /^tgs_([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)(?:\.([A-Za-z0-9]+))?$/.exec(String(id || ''));
  if (!match) return null;

  const payload = match[1];
  const signature = match[2];
  const extensionFromSuffix = sanitizeFileExtension(match[3] || 'bin');
  let valid = false;

  for (const secret of getFileLinkSecrets(env)) {
    const expected = await signPayload(payload, secret);
    if (timingSafeEqual(signature, expected)) {
      valid = true;
      break;
    }
  }

  if (!valid) return null;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(base64UrlDecodeToString(payload));
  } catch {
    return null;
  }
  if (!parsed?.f) return null;

  return {
    version: Number(parsed.v || 1),
    fileId: String(parsed.f),
    fileExtension: sanitizeFileExtension(String(parsed.e || extensionFromSuffix || 'bin')),
    fileName: parsed.n ? String(parsed.n) : '',
    mimeType: parsed.m ? String(parsed.m) : '',
    fileSize: Number(parsed.s || 0),
    timestamp: Number(parsed.t || 0),
    messageId: parsed.mid ? Number(parsed.mid) : null,
  };
}

export function truncateFileName(fileName: string, limit = 180): string {
  const value = String(fileName || '');
  return value.length <= limit ? value : value.slice(0, limit);
}

function formatFileSize(bytes: number): string {
  const numeric = Number(bytes || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return '0 B';
  if (numeric < 1024) return `${numeric} B`;
  if (numeric < 1024 * 1024) return `${(numeric / 1024).toFixed(2)} KB`;
  if (numeric < 1024 * 1024 * 1024) return `${(numeric / (1024 * 1024)).toFixed(2)} MB`;
  return `${(numeric / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function buildTelegramUploadNoticeText({
  directLink,
  fileId,
  messageId,
  fileName,
  fileSize,
}: {
  directLink: string;
  fileId: string;
  messageId?: number | null;
  fileName: string;
  fileSize: number;
}): string {
  const lines = [
    'Upload completed',
    `Name: ${truncateFileName(fileName || '', 120) || 'unnamed'}`,
    `Size: ${formatFileSize(fileSize)}`,
    `Direct Link: ${directLink}`,
    `File ID: ${fileId}`,
  ];
  if (messageId) lines.push(`Message ID: ${messageId}`);
  return lines.join('\n');
}

async function postTelegramMessage(
  payload: Record<string, unknown>,
  env: Env
): Promise<{ ok: boolean; data: TelegramApiResult }> {
  const response = await fetch(buildTelegramBotApiUrl(env, 'sendMessage'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(8000),
  });
  const data = (await response.json().catch(() => ({}))) as TelegramApiResult;
  return { ok: response.ok && Boolean(data?.ok), data };
}

export async function sendTelegramUploadNotice(
  {
    chatId,
    replyToMessageId,
    directLink,
    fileId,
    messageId,
    fileName,
    fileSize,
  }: {
    chatId?: string;
    replyToMessageId?: number | null;
    directLink: string;
    fileId: string;
    messageId?: number | null;
    fileName: string;
    fileSize: number;
  },
  env: Env
): Promise<{ ok: boolean; skipped?: boolean; reason?: string }> {
  if (!shouldNotifyTelegramUpload(env)) {
    return { ok: false, skipped: true, reason: 'disabled' };
  }

  const targetChatId = String(chatId || getTelegramChatId(env)).trim();
  if (!targetChatId || !getTelegramToken(env)) {
    return { ok: false, skipped: true, reason: 'missing-config' };
  }

  const text = buildTelegramUploadNoticeText({
    directLink,
    fileId,
    messageId,
    fileName,
    fileSize,
  });

  const payload: Record<string, unknown> = {
    chat_id: targetChatId,
    text,
    disable_web_page_preview: true,
  };

  if (replyToMessageId) {
    payload.reply_to_message_id = Number(replyToMessageId);
    payload.allow_sending_without_reply = true;
  }

  try {
    let result = await postTelegramMessage(payload, env);
    if (!result.ok && payload.reply_to_message_id) {
      result = await postTelegramMessage(
        {
          chat_id: targetChatId,
          text,
          disable_web_page_preview: true,
        },
        env
      );
    }
    return { ok: result.ok };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function getTelegramFilePath(env: Env, fileId: string): Promise<string | null> {
  try {
    const url = `${buildTelegramBotApiUrl(env, 'getFile')}?file_id=${encodeURIComponent(fileId)}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return null;
    const data = (await response.json().catch(() => ({}))) as TelegramApiResult;
    return data?.ok && data.result?.file_path ? data.result.file_path : null;
  } catch {
    return null;
  }
}

export interface TelegramBotInfo {
  connected: boolean;
  message: string;
  botName?: string;
  botUsername?: string;
  apiBase: string;
}

export async function getTelegramBotInfo(env: Env): Promise<TelegramBotInfo> {
  const apiBase = getTelegramApiBase(env);
  if (!getTelegramToken(env)) {
    return { connected: false, message: 'Not configured', apiBase };
  }

  try {
    const response = await fetch(buildTelegramBotApiUrl(env, 'getMe'), {
      signal: AbortSignal.timeout(8000),
    });
    const data = (await response.json().catch(() => ({}))) as TelegramApiResult;
    if (response.ok && data?.ok) {
      return {
        connected: true,
        message: `Connected: @${data.result?.username || 'unknown'}`,
        botName: data.result?.first_name || '',
        botUsername: data.result?.username || '',
        apiBase,
      };
    }
    return {
      connected: false,
      message: data?.description || 'Telegram API check failed',
      apiBase,
    };
  } catch (error) {
    return {
      connected: false,
      message: error instanceof Error ? error.message : 'Telegram API check failed',
      apiBase,
    };
  }
}

export async function deleteTelegramMessage(
  env: Env,
  chatId: string,
  messageId: number
): Promise<void> {
  if (!chatId || !messageId || !getTelegramToken(env)) return;
  try {
    await fetch(buildTelegramBotApiUrl(env, 'deleteMessage'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(8000),
      body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
    });
  } catch {
    // Remote deletion is best-effort; metadata deletion still proceeds.
  }
}
