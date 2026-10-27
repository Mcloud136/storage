import type { Env } from '../env';
import type { FileMetadata } from '../core/keys';
import type { OpenInput, OpenResult, PutInput, PutResult, StorageBackend } from './types';
import { StorageError } from './types';
import {
  checkGitHubConnection,
  deleteGitHubFile,
  getGitHubFile,
  hasGitHubConfig,
  uploadToGitHub,
} from './github-legacy';

const MAX_GITHUB_BYTES = 100 * 1024 * 1024;

export function createGitHubBackend(env: Env): StorageBackend {
  return {
    type: 'github',
    caps: {
      range: true,
      maxBytes: MAX_GITHUB_BYTES,
      streamUp: false,
    },

    async put(input: PutInput): Promise<PutResult> {
      if (!hasGitHubConfig(env)) {
        throw new StorageError('NOT_CONFIGURED', 'GitHub token or repo is not configured.');
      }

      const buffer =
        input.body instanceof ArrayBuffer
          ? input.body
          : await new Response(input.body).arrayBuffer();
      const storageKey = input.folderPath ? `${input.folderPath}/${input.id}` : input.id;
      const result = await uploadToGitHub(buffer, storageKey, input.fileName, input.contentType, env);

      const resolvedKey = result?.storagePath || storageKey;
      return {
        storageKey: resolvedKey,
        meta: {
          githubStorageKey: resolvedKey,
          ...(result?.metadata || {}),
        },
      };
    },

    async open(input: OpenInput): Promise<OpenResult> {
      const metadata = input.record.metadata as FileMetadata;
      const storageKey = String(
        metadata.githubStorageKey || input.record.storageKey || input.record.id
      );
      if (!storageKey) {
        throw new StorageError('NOT_FOUND', 'GitHub storage key is missing from metadata.', 404);
      }
      if (!hasGitHubConfig(env)) {
        throw new StorageError('NOT_CONFIGURED', 'GitHub token or repo is not configured.');
      }

      const response = (await getGitHubFile(storageKey, metadata, env, {
        range: input.range,
        method: input.method,
      })) as Response | null;

      if (!response) {
        throw new StorageError('NOT_FOUND', 'GitHub file not found.', 404);
      }
      if (response.status === 404) {
        throw new StorageError('NOT_FOUND', 'GitHub file not found.', 404);
      }
      if (!response.ok && response.status !== 206) {
        throw new StorageError('UPSTREAM', 'GitHub download failed.', response.status);
      }

      return {
        status: response.status,
        headers: response.headers,
        body: input.method === 'HEAD' ? null : response.body,
      };
    },

    async remove(record): Promise<void> {
      const metadata = record.metadata as FileMetadata;
      const storageKey = String(
        metadata.githubStorageKey || record.storageKey || record.id
      );
      if (!storageKey) return;
      const deleted = await deleteGitHubFile(storageKey, metadata, env);
      if (!deleted) {
        throw new StorageError('UPSTREAM', 'GitHub delete failed.');
      }
    },

    async check(): Promise<{ connected: boolean; message: string }> {
      const result = await checkGitHubConnection(env);
      return {
        connected: Boolean(result?.connected),
        message: result?.connected
          ? `Connected${result.mode ? ` (${result.mode})` : ''}`
          : result?.message || 'GitHub check failed',
      };
    },
  };
}
