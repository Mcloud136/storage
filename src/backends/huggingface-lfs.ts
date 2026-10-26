import type { Env } from '../env';
import { getHuggingFaceConfig } from './huggingface-legacy';
import { StorageError } from './types';

const HF_BASE_URL = 'https://huggingface.co';

export interface HfLfsPart {
  partNumber: number;
  url: string;
}

export type HfDirectPlan =
  | { mode: 'regular' }
  | { mode: 'exists'; oid: string; size: number }
  | { mode: 'single'; oid: string; size: number; uploadUrl: string }
  | {
      mode: 'multipart';
      oid: string;
      size: number;
      partSize: number;
      parts: HfLfsPart[];
      completionUrl: string;
    };

function config(env: Env) {
  const { token, repo, configured } = getHuggingFaceConfig(env);
  if (!configured) {
    throw new StorageError('NOT_CONFIGURED', 'HuggingFace token or repo is not configured.');
  }
  return { token, repo };
}

async function readError(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  if (!text) return `${response.status} ${response.statusText}`;
  try {
    const data = JSON.parse(text);
    return data.error || data.message || text;
  } catch {
    return text;
  }
}

export async function planHuggingFaceDirectUpload(
  env: Env,
  input: { path: string; size: number; oid: string; sampleBase64: string }
): Promise<HfDirectPlan> {
  const { token, repo } = config(env);

  const preupload = await fetch(`${HF_BASE_URL}/api/datasets/${repo}/preupload/main`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      files: [{ path: input.path, size: input.size, sample: input.sampleBase64 }],
    }),
  });

  if (!preupload.ok) {
    throw new StorageError('UPSTREAM', `HuggingFace 预上传检查失败：${await readError(preupload)}`);
  }

  const preuploadData = (await preupload.json()) as {
    files?: Array<{ path?: string; uploadMode?: string }>;
  };
  const files = Array.isArray(preuploadData?.files) ? preuploadData.files : [];
  const fileInfo = files.find((item) => item.path === input.path) || files[0];
  if (fileInfo?.uploadMode !== 'lfs') {
    return { mode: 'regular' };
  }

  const batch = await fetch(`${HF_BASE_URL}/datasets/${repo}.git/info/lfs/objects/batch`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.git-lfs+json',
      'Content-Type': 'application/vnd.git-lfs+json',
    },
    body: JSON.stringify({
      operation: 'upload',
      transfers: ['basic', 'multipart'],
      hash_algo: 'sha_256',
      ref: { name: 'main' },
      objects: [{ oid: input.oid, size: input.size }],
    }),
  });

  if (!batch.ok) {
    throw new StorageError('UPSTREAM', `HuggingFace LFS 握手失败：${await readError(batch)}`);
  }

  const batchData = (await batch.json()) as {
    objects?: Array<{
      oid?: string;
      size?: number;
      error?: { message?: string };
      actions?: { upload?: { href?: string; header?: Record<string, unknown> } };
    }>;
  };
  const object = Array.isArray(batchData?.objects) ? batchData.objects[0] : null;
  if (!object) {
    throw new StorageError('UPSTREAM', 'HuggingFace LFS 返回数据格式异常。');
  }
  if (object.error) {
    throw new StorageError(
      'UPSTREAM',
      `HuggingFace LFS 错误：${object.error.message || JSON.stringify(object.error)}`
    );
  }

  const oid = String(object.oid || input.oid);
  const size = Number(object.size || input.size);
  const upload = object.actions?.upload;
  if (!upload?.href) {
    return { mode: 'exists', oid, size };
  }

  const header = upload.header || {};
  const chunkSize = Number(header.chunk_size || 0);
  const partKeys = Object.keys(header)
    .filter((key) => /^\d+$/.test(key))
    .sort((a, b) => Number(a) - Number(b));

  if (chunkSize > 0 && partKeys.length > 0) {
    const expected = Math.ceil(size / chunkSize);
    if (partKeys.length !== expected) {
      throw new StorageError(
        'UPSTREAM',
        `HuggingFace LFS 分片数量异常：期望 ${expected}，实际 ${partKeys.length}。`
      );
    }
    const parts = partKeys.map((key) => ({
      partNumber: Number(key),
      url: String(header[key]),
    }));
    if (parts.some((part) => !/^https?:\/\//i.test(part.url))) {
      throw new StorageError('UPSTREAM', 'HuggingFace LFS 返回了无效的分片上传地址。');
    }
    return {
      mode: 'multipart',
      oid,
      size,
      partSize: chunkSize,
      parts,
      completionUrl: String(upload.href),
    };
  }

  return { mode: 'single', oid, size, uploadUrl: String(upload.href) };
}

export async function completeHuggingFaceMultipart(
  env: Env,
  input: { oid: string; completionUrl: string; parts: Array<{ partNumber: number; etag: string }> }
): Promise<void> {
  config(env);
  const response = await fetch(input.completionUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.git-lfs+json',
      'Content-Type': 'application/vnd.git-lfs+json',
    },
    body: JSON.stringify({
      oid: input.oid,
      parts: input.parts
        .slice()
        .sort((a, b) => a.partNumber - b.partNumber)
        .map((part) => ({ partNumber: part.partNumber, etag: part.etag })),
    }),
  });

  if (!response.ok) {
    throw new StorageError('UPSTREAM', `HuggingFace 分片合并失败：${await readError(response)}`);
  }
}

export async function commitHuggingFaceLfs(
  env: Env,
  input: { path: string; oid: string; size: number; fileName: string }
): Promise<string> {
  const { token, repo } = config(env);
  const body = [
    JSON.stringify({ key: 'header', value: { summary: `Upload ${input.fileName || input.path}` } }),
    JSON.stringify({
      key: 'lfsFile',
      value: { path: input.path, algo: 'sha256', size: input.size, oid: input.oid },
    }),
  ].join('\n');

  const response = await fetch(`${HF_BASE_URL}/api/datasets/${repo}/commit/main`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/x-ndjson',
    },
    body,
  });

  if (!response.ok) {
    throw new StorageError('UPSTREAM', `HuggingFace 提交失败：${await readError(response)}`);
  }

  const data = (await response.json()) as { commitOid?: string };
  return String(data?.commitOid || '');
}
