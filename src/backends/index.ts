import type { Env } from '../env';
import { createTelegramBackend } from './telegram';
import { createWebDAVBackend, hasWebDAVConfig } from './webdav';
import { createHuggingFaceBackend } from './huggingface';
import { createGitHubBackend } from './github';
import { hasHuggingFaceConfig } from './huggingface-legacy';
import { hasGitHubConfig } from './github-legacy';
import { getTelegramChatId, getTelegramToken } from '../lib/telegram';
import type { StorageBackend } from './types';
import { StorageError } from './types';

export const SUPPORTED_STORAGE_MODES = ['telegram', 'webdav', 'huggingface', 'github'] as const;

export function normalizeStorageMode(value: string): string {
  return String(value || '').trim().toLowerCase();
}

export function createBackend(type: string, env: Env): StorageBackend {
  const normalized = normalizeStorageMode(type);
  if (normalized === 'telegram') return createTelegramBackend(env);
  if (normalized === 'webdav') return createWebDAVBackend(env);
  if (normalized === 'huggingface') return createHuggingFaceBackend(env);
  if (normalized === 'github') return createGitHubBackend(env);
  throw new StorageError(
    'NOT_CONFIGURED',
    `Storage backend "${normalized || 'unknown'}" is not implemented in v2 M3.`
  );
}

export function isBackendConfigured(type: string, env: Env): boolean {
  const normalized = normalizeStorageMode(type);
  if (normalized === 'telegram') {
    return Boolean(getTelegramToken(env) && getTelegramChatId(env));
  }
  if (normalized === 'webdav') {
    return hasWebDAVConfig(env);
  }
  if (normalized === 'huggingface') {
    return hasHuggingFaceConfig(env);
  }
  if (normalized === 'github') {
    return hasGitHubConfig(env);
  }
  return false;
}

export function isSupportedStorageMode(type: string): boolean {
  return SUPPORTED_STORAGE_MODES.includes(
    normalizeStorageMode(type) as (typeof SUPPORTED_STORAGE_MODES)[number]
  );
}
