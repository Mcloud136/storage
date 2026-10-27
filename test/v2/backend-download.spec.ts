import { afterEach, describe, expect, it, vi } from 'vitest';
import { getHuggingFaceFile } from '../../src/backends/huggingface-legacy';
import { getGitHubFile } from '../../src/backends/github-legacy';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('backend download method propagation', () => {
  it('uses HEAD and encodes each HuggingFace path segment', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        return new Response(null, { status: 200 });
      })
    );

    await getHuggingFaceFile('folder/a b#c.bin', {
      HF_TOKEN: 'hf_test',
      HF_REPO: 'owner/repo',
    } as never, { method: 'HEAD' });

    expect(calls[0].url).toContain('/folder/a%20b%23c.bin');
    expect(calls[0].init?.method).toBe('HEAD');
  });

  it('uses HEAD for GitHub contents downloads', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        return new Response(null, { status: 200 });
      })
    );

    await getGitHubFile(
      'folder/file.bin',
      { githubMode: 'contents', githubPath: 'folder/a b.bin' },
      { GITHUB_TOKEN: 'gh_test', GITHUB_REPO: 'owner/repo', GITHUB_MODE: 'contents' } as never,
      { method: 'HEAD' }
    );

    expect(calls[0].init?.method).toBe('HEAD');
    expect(calls[0].url).toContain('folder/a%20b.bin');
  });
});
