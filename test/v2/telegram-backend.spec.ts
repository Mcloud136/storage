import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/env';
import { createTelegramBackend } from '../../src/backends/telegram';

const env = {
  TG_Bot_Token: '123:test-token',
  TG_Chat_ID: '-1001234567890',
} as Env;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Telegram backend', () => {
  it('uploads as a document and returns the telegram file id', async () => {
    const captured: { uploaded: FormData | null } = { uploaded: null };

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: any, init?: any) => {
        const url = String(input);
        if (url.includes('/sendDocument')) {
          captured.uploaded = init?.body as FormData;
          return new Response(
            JSON.stringify({
              ok: true,
              result: { message_id: 42, document: { file_id: 'FILE123' } },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return new Response('unexpected', { status: 500 });
      })
    );

    const backend = createTelegramBackend(env);
    const result = await backend.put({
      id: 'placeholder',
      fileName: 'note.txt',
      contentType: 'text/plain',
      body: new TextEncoder().encode('hello').buffer as ArrayBuffer,
      size: 5,
    });

    expect(result.storageKey).toBe('FILE123.txt');
    expect(result.meta.telegramFileId).toBe('FILE123');
    expect(result.meta.telegramMessageId).toBe(42);
    expect(captured.uploaded?.get('chat_id')).toBe('-1001234567890');
  });

  it('resolves getFile and proxies a range response', async () => {
    const urls: string[] = [];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: any) => {
        const url = String(input);
        urls.push(url);
        if (url.includes('/getFile')) {
          return new Response(
            JSON.stringify({ ok: true, result: { file_path: 'documents/file_9.txt' } }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (url.includes('/file/bot')) {
          return new Response('hello', {
            status: 206,
            headers: { 'Content-Range': 'bytes 0-4/5' },
          });
        }
        return new Response('unexpected', { status: 500 });
      })
    );

    const backend = createTelegramBackend(env);
    const result = await backend.open({
      record: {
        id: 'FILE999.txt',
        storageType: 'telegram',
        storageKey: 'FILE999.txt',
        metadata: { telegramFileId: 'FILE999', telegramMessageId: 1 },
      },
      method: 'GET',
      range: 'bytes=0-4',
    });

    expect(result.status).toBe(206);
    expect(await new Response(result.body).text()).toBe('hello');
    expect(urls.some((url) => url.includes('/getFile'))).toBe(true);
    expect(urls.some((url) => url.includes('/file/bot'))).toBe(true);
  });

  it('reports getMe status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response(
          JSON.stringify({ ok: true, result: { username: 'WXMuMaBot', first_name: 'bot' } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      })
    );

    const backend = createTelegramBackend(env);
    const result = await backend.check();
    expect(result.connected).toBe(true);
    expect(result.message).toContain('WXMuMaBot');
  });
});
