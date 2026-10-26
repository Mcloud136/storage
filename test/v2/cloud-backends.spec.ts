import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/env';
import { createHuggingFaceBackend } from '../../src/backends/huggingface';
import { createGitHubBackend } from '../../src/backends/github';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HuggingFace backend', () => {
  const env = {
    HF_TOKEN: 'hf_test',
    HF_REPO: 'owner/dataset',
  } as Env;

  it('uploads regular files through preupload + commit', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: any) => {
        const url = String(input);
        calls.push(url);
        if (url.includes('/preupload/main')) {
          return new Response(
            JSON.stringify({ files: [{ path: 'hf_1.txt', uploadMode: 'regular' }] }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (url.includes('/commit/main')) {
          return new Response(JSON.stringify({ commitOid: 'abc123' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('unexpected', { status: 500 });
      })
    );

    const backend = createHuggingFaceBackend(env);
    const result = await backend.put({
      id: 'hf_1.txt',
      fileName: 'a.txt',
      contentType: 'text/plain',
      body: new TextEncoder().encode('hello').buffer as ArrayBuffer,
      size: 5,
    });

    expect(result.storageKey).toBe('hf_1.txt');
    expect(result.meta.hfPath).toBe('hf_1.txt');
    expect(calls.some((url) => url.includes('/preupload/main'))).toBe(true);
    expect(calls.some((url) => url.includes('/commit/main'))).toBe(true);
  });

  it('proxies ranged downloads through resolve URLs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response('hello', {
          status: 206,
          headers: { 'Content-Range': 'bytes 0-4/5' },
        });
      })
    );

    const backend = createHuggingFaceBackend(env);
    const result = await backend.open({
      record: {
        id: 'hf:hf_1.txt',
        storageType: 'huggingface',
        storageKey: 'hf_1.txt',
        metadata: { hfPath: 'hf_1.txt' },
      },
      method: 'GET',
      range: 'bytes=0-4',
    });

    expect(result.status).toBe(206);
    expect(await new Response(result.body).text()).toBe('hello');
  });
});

describe('GitHub backend (contents mode)', () => {
  const env = {
    GITHUB_TOKEN: 'gh_test',
    GITHUB_REPO: 'owner/repo',
    GITHUB_MODE: 'contents',
  } as Env;

  it('uploads via the contents API', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: any, init?: any) => {
        const url = String(input);
        const method = String(init?.method || 'GET').toUpperCase();
        if (url.includes('/contents/')) {
          if (method === 'GET') return new Response('not found', { status: 404 });
          if (method === 'PUT') {
            return new Response(JSON.stringify({ content: { sha: 'sha123' } }), {
              status: 201,
              headers: { 'Content-Type': 'application/json' },
            });
          }
        }
        return new Response('unexpected', { status: 500 });
      })
    );

    const backend = createGitHubBackend(env);
    const result = await backend.put({
      id: 'github_1.txt',
      fileName: 'a.txt',
      contentType: 'text/plain',
      body: new TextEncoder().encode('hi').buffer as ArrayBuffer,
      size: 2,
    });

    expect(result.storageKey).toBe('github_1.txt');
    expect(result.meta.githubMode).toBe('contents');
    expect(result.meta.githubPath).toBe('github_1.txt');
  });

  it('proxies raw contents downloads', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('hello', { status: 200 }))
    );

    const backend = createGitHubBackend(env);
    const result = await backend.open({
      record: {
        id: 'github:github_1.txt',
        storageType: 'github',
        storageKey: 'github_1.txt',
        metadata: { githubMode: 'contents', githubPath: 'github_1.txt' },
      },
      method: 'GET',
    });

    expect(result.status).toBe(200);
    expect(await new Response(result.body).text()).toBe('hello');
  });
});
