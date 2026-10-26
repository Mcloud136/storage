/**
 * KV key compatibility layer.
 *
 * File records store an empty value and all data in metadata. The legacy
 * implementation probes up to 10 type prefixes plus the bare key; this module
 * keeps the same candidate set but tries the bare key first for the common
 * Telegram case.
 */

export const KEY_PREFIXES = [
  'img:',
  'vid:',
  'aud:',
  'doc:',
  'r2:',
  's3:',
  'discord:',
  'hf:',
  'webdav:',
  'github:',
  '',
] as const;

const KNOWN_PREFIXES = KEY_PREFIXES.filter((prefix) => prefix !== '');

const PREFIX_TO_STORAGE: Record<string, string> = {
  'r2:': 'r2',
  's3:': 's3',
  'discord:': 'discord',
  'hf:': 'huggingface',
  'webdav:': 'webdav',
  'github:': 'github',
};

export interface FileMetadata {
  TimeStamp?: number;
  ListType?: string;
  Label?: string;
  liked?: boolean;
  fileName?: string;
  fileSize?: number;
  storageType?: string;
  storage?: string;

  telegramFileId?: string;
  telegramMessageId?: number;
  r2Key?: string;
  s3Key?: string;
  discordChannelId?: string;
  discordMessageId?: string;
  discordAttachmentId?: string;
  discordUploadMode?: string;
  discordSourceUrl?: string;
  hfPath?: string;
  webdavPath?: string;
  webdavEtag?: string;
  githubStorageKey?: string;
  githubMode?: string;
  githubRepo?: string;
  githubPath?: string;
  githubSha?: string;
  githubReleaseId?: number;
  githubAssetId?: number;
  githubAssetName?: string;
  githubDownloadUrl?: string;

  folderPath?: string;
  signedLink?: boolean;
  chunked?: boolean;
  totalChunks?: number;
  fromWebhook?: boolean;
  source?: string;

  shareExpiresAt?: number;
  sharePasswordSalt?: string;
  sharePasswordHash?: string;
  shareMaxDownloads?: number;
  shareDownloadCount?: number;
  shareSlug?: string;

  [key: string]: unknown;
}

export interface KvRecord {
  value: string | null;
  metadata: FileMetadata | null;
}

export function hasKnownPrefix(id: string): boolean {
  return KNOWN_PREFIXES.some((prefix) => id.startsWith(prefix));
}

export function candidateKeys(id: string, maxPrefixes = KNOWN_PREFIXES.length): string[] {
  if (hasKnownPrefix(id)) {
    return [id];
  }
  return [id, ...KNOWN_PREFIXES.slice(0, maxPrefixes).map((prefix) => `${prefix}${id}`)];
}

export function inferStorageType(id: string, metadata: FileMetadata = {}): string {
  const explicit = metadata.storageType || metadata.storage;
  if (explicit) {
    return String(explicit).toLowerCase();
  }
  for (const [prefix, storageType] of Object.entries(PREFIX_TO_STORAGE)) {
    if (String(id).startsWith(prefix)) {
      return storageType;
    }
  }
  return 'telegram';
}

export function parseKey(key: string): string {
  for (const prefix of KNOWN_PREFIXES) {
    if (key.startsWith(prefix)) {
      return key.slice(prefix.length);
    }
  }
  return key;
}
