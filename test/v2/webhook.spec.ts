import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { FileMetadata } from '../../src/core/keys';

const BASE = 'https://example.com';

function webhookRequest(secret: string, body: unknown): Promise<Response> {
  return exports.default.fetch(`${BASE}/api/telegram/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': secret,
    },
    body: JSON.stringify(body),
  });
}

describe('Telegram webhook', () => {
  it('rejects a missing or wrong secret', async () => {
    const missing = await exports.default.fetch(`${BASE}/api/telegram/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(missing.status).toBe(401);

    const wrong = await webhookRequest('wrong', {});
    expect(wrong.status).toBe(401);
  });

  it('ignores messages from other chats', async () => {
    const response = await webhookRequest('test-webhook-secret', {
      message: {
        message_id: 1,
        chat: { id: 999 },
        document: { file_id: 'FILE-X', file_name: 'x.txt', mime_type: 'text/plain', file_size: 1 },
      },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ignored: string };
    expect(body.ignored).toBe('chat-mismatch');
  });

  it('writes metadata and returns a signed direct link', async () => {
    const fileId = `FILEWEBHOOK${Date.now()}`;
    const response = await webhookRequest('test-webhook-secret', {
      update_id: Date.now(),
      message: {
        message_id: 42,
        chat: { id: -1001234567890 },
        document: {
          file_id: fileId,
          file_name: 'webhook.txt',
          mime_type: 'text/plain',
          file_size: 7,
        },
      },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; directLink: string; mode: string };
    expect(body.ok).toBe(true);
    expect(body.mode).toBe('signed');
    expect(body.directLink).toContain('/file/tgs_');

    const stored = await env.img_url.getWithMetadata<FileMetadata>(`${fileId}.txt`);
    expect(stored?.metadata?.fromWebhook).toBe(true);
    expect(stored?.metadata?.telegramFileId).toBe(fileId);
  });

  it('ignores duplicate update_id deliveries', async () => {
    const updateId = Date.now() + 1;
    const payload = {
      update_id: updateId,
      message: {
        message_id: 43,
        chat: { id: -1001234567890 },
        document: {
          file_id: `FILEDUP${updateId}`,
          file_name: 'dup.txt',
          mime_type: 'text/plain',
          file_size: 1,
        },
      },
    };
    const first = await webhookRequest('test-webhook-secret', payload);
    expect(first.status).toBe(200);
    const second = await webhookRequest('test-webhook-secret', payload);
    expect(second.status).toBe(200);
    const body = (await second.json()) as { duplicate?: boolean };
    expect(body.duplicate).toBe(true);
  });
});
