import { exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  commitHuggingFaceLfs,
  completeHuggingFaceMultipart,
  planHuggingFaceDirectUpload,
} from '../../src/backends/huggingface-lfs';

const env = { HF_TOKEN: 'hf_test_token', HF_REPO: 'wxmuma/test-repo' } as never;
const oid = 'a'.repeat(64);
const BASE = 'https://example.com';

async function loginCookie(): Promise<string> {
  const response = await exports.default.fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'test-pass' }),
  });
  expect(response.status).toBe(200);
  return (response.headers.get('Set-Cookie') || '').split(';')[0];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HuggingFace LFS direct upload', () => {
  it('returns regular when preupload does not select LFS', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ files: [{ path: 'f.bin', uploadMode: 'regular' }] }), {
        status: 200,
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const plan = await planHuggingFaceDirectUpload(env, {
      path: 'f.bin',
      size: 10 * 1024 * 1024,
      oid,
      sampleBase64: 'AA==',
    });

    expect(plan).toEqual({ mode: 'regular' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('builds multipart parts from the LFS batch header', async () => {
    const size = 100 * 1024 * 1024;
    const partSize = 5 * 1024 * 1024;
    const header: Record<string, string> = { chunk_size: String(partSize) };
    for (let index = 1; index <= 20; index += 1) {
      header[String(index)] = `https://cdn.example.com/part/${index}`;
    }

    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('/preupload/')) {
        return new Response(JSON.stringify({ files: [{ path: 'f.bin', uploadMode: 'lfs' }] }), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify({
          objects: [
            {
              oid,
              size,
              actions: { upload: { href: 'https://hf.example.com/complete', header } },
            },
          ],
        }),
        { status: 200 }
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const plan = await planHuggingFaceDirectUpload(env, {
      path: 'f.bin',
      size,
      oid,
      sampleBase64: 'AA==',
    });

    expect(plan.mode).toBe('multipart');
    if (plan.mode !== 'multipart') throw new Error('expected multipart');
    expect(plan.partSize).toBe(partSize);
    expect(plan.parts).toHaveLength(20);
    expect(plan.parts[19]).toEqual({
      partNumber: 20,
      url: 'https://cdn.example.com/part/20',
    });
    expect(plan.completionUrl).toBe('https://hf.example.com/complete');
  });

  it('treats missing upload actions as an already uploaded object', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) => {
        if (String(url).includes('/preupload/')) {
          return new Response(JSON.stringify({ files: [{ path: 'f.bin', uploadMode: 'lfs' }] }), {
            status: 200,
          });
        }
        return new Response(JSON.stringify({ objects: [{ oid, size: 10 }] }), { status: 200 });
      })
    );

    const plan = await planHuggingFaceDirectUpload(env, {
      path: 'f.bin',
      size: 10,
      oid,
      sampleBase64: 'AA==',
    });

    expect(plan).toEqual({ mode: 'exists', oid, size: 10 });
  });

  it('completes multipart and commits the LFS pointer', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(url), init });
        if (String(url).includes('/complete')) {
          return new Response('{}', { status: 200 });
        }
        return new Response(JSON.stringify({ commitOid: 'commit-sha' }), { status: 200 });
      })
    );

    await completeHuggingFaceMultipart(env, {
      oid,
      completionUrl: 'https://hf.example.com/complete',
      parts: [
        { partNumber: 2, etag: 'e2' },
        { partNumber: 1, etag: 'e1' },
      ],
    });
    const commitOid = await commitHuggingFaceLfs(env, {
      path: 'folder/f.bin',
      oid,
      size: 100,
      fileName: 'f.bin',
    });

    expect(commitOid).toBe('commit-sha');
    const completeBody = JSON.parse(String(requests[0].init?.body));
    expect(completeBody.parts).toEqual([
      { partNumber: 1, etag: 'e1' },
      { partNumber: 2, etag: 'e2' },
    ]);
    const commitBody = String(requests[1].init?.body);
    expect(commitBody).toContain('"key":"lfsFile"');
    expect(commitBody).toContain('"oid":"' + oid + '"');
    expect(commitBody).toContain('"path":"folder/f.bin"');
  });

  it('runs init and complete through the chunked upload routes', async () => {
    const cookie = await loginCookie();
    const size = 40 * 1024 * 1024;
    const partSize = 5 * 1024 * 1024;
    const header: Record<string, string> = { chunk_size: String(partSize) };
    for (let index = 1; index <= 8; index += 1) {
      header[String(index)] = `https://cdn.example.com/part/${index}`;
    }

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) => {
        const target = String(url);
        if (target.includes('/preupload/')) {
          return new Response(JSON.stringify({ files: [{ path: 'folder/f.bin', uploadMode: 'lfs' }] }), {
            status: 200,
          });
        }
        if (target.includes('.git/info/lfs/objects/batch')) {
          return new Response(
            JSON.stringify({
              objects: [
                {
                  oid,
                  size,
                  actions: { upload: { href: 'https://hf.example.com/complete', header } },
                },
              ],
            }),
            { status: 200 }
          );
        }
        if (target === 'https://hf.example.com/complete') {
          return new Response('{}', { status: 200 });
        }
        return new Response(JSON.stringify({ commitOid: 'commit-sha' }), { status: 200 });
      })
    );

    const initResponse = await exports.default.fetch(`${BASE}/api/chunked-upload/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        fileName: 'f.bin',
        fileSize: size,
        fileType: 'application/octet-stream',
        storageMode: 'huggingface',
        folderPath: 'folder',
        totalChunks: 8,
        fileHash: oid,
        sample: 'AA==',
      }),
    });
    expect(initResponse.status).toBe(200);
    const init = (await initResponse.json()) as {
      uploadId: string;
      mode: string;
      partSize: number;
      parts: Array<{ partNumber: number; url: string }>;
    };
    expect(init.mode).toBe('hf-direct');
    expect(init.partSize).toBe(partSize);
    expect(init.parts).toHaveLength(8);

    const completeResponse = await exports.default.fetch(`${BASE}/api/chunked-upload/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        uploadId: init.uploadId,
        etags: init.parts.map((part) => ({ partNumber: part.partNumber, etag: `etag-${part.partNumber}` })),
      }),
    });
    expect(completeResponse.status).toBe(200);
    const complete = (await completeResponse.json()) as { src: string };
    expect(complete.src).toMatch(/^\/file\/hf:/);
  });
});
