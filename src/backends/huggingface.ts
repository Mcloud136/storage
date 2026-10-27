import type { Env } from '../env';
import type { FileMetadata } from '../core/keys';
import type { OpenInput, OpenResult, PutInput, PutResult, StorageBackend } from './types';
import { StorageError } from './types';
import {
  checkHuggingFaceConnection,
  deleteHuggingFaceFile,
  getHuggingFaceFile,
  hasHuggingFaceConfig,
  uploadToHuggingFace,
} from './huggingface-legacy';

const MAX_HF_BYTES = 35 * 1024 * 1024;

export function createHuggingFaceBackend(env: Env): StorageBackend {
  return {
    type: 'huggingface',
    caps: {
      range: true,
      maxBytes: MAX_HF_BYTES,
      streamUp: false,
    },

    async put(input: PutInput): Promise<PutResult> {
      if (!hasHuggingFaceConfig(env)) {
        throw new StorageError('NOT_CONFIGURED', 'HuggingFace token or repo is not configured.');
      }

      const buffer =
        input.body instanceof ArrayBuffer
          ? input.body
          : await new Response(input.body).arrayBuffer();
      const objectPath = input.folderPath ? `${input.folderPath}/${input.id}` : input.id;
      const result = await uploadToHuggingFace(buffer, objectPath, input.fileName, env);

      if (!result?.success) {
        throw new StorageError('UPSTREAM', result?.error || 'HuggingFace upload failed.');
      }

      return {
        storageKey: objectPath,
        meta: {
          hfPath: objectPath,
          ...(result.commitOid ? { hfCommit: result.commitOid } : {}),
        },
      };
    },

    async open(input: OpenInput): Promise<OpenResult> {
      const metadata = input.record.metadata as FileMetadata;
      const objectPath = String(metadata.hfPath || '');
      if (!objectPath) {
        throw new StorageError('NOT_FOUND', 'HuggingFace path is missing from metadata.', 404);
      }
      if (!hasHuggingFaceConfig(env)) {
        throw new StorageError('NOT_CONFIGURED', 'HuggingFace token or repo is not configured.');
      }

      const response = (await getHuggingFaceFile(objectPath, env, {
        range: input.range,
        method: input.method,
      })) as Response;

      if (!response) {
        throw new StorageError('NOT_FOUND', 'HuggingFace file not found.', 404);
      }
      if (response.status === 404) {
        throw new StorageError('NOT_FOUND', 'HuggingFace file not found.', 404);
      }
      if (!response.ok && response.status !== 206) {
        throw new StorageError('UPSTREAM', 'HuggingFace download failed.', response.status);
      }

      return {
        status: response.status,
        headers: response.headers,
        body: input.method === 'HEAD' ? null : response.body,
      };
    },

    async remove(record): Promise<void> {
      const metadata = record.metadata as FileMetadata;
      const objectPath = String(metadata.hfPath || '');
      if (!objectPath) return;
      const deleted = await deleteHuggingFaceFile(objectPath, env);
      if (!deleted) {
        throw new StorageError('UPSTREAM', 'HuggingFace delete failed.');
      }
    },

    async check(): Promise<{ connected: boolean; message: string }> {
      const result = await checkHuggingFaceConnection(env);
      return {
        connected: Boolean(result?.connected),
        message: result?.connected
          ? `Connected: ${result.repoId || 'dataset'}`
          : result?.error || 'HuggingFace check failed',
      };
    },
  };
}
