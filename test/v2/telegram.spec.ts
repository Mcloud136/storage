import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { Env } from '../../src/env';
import { createSignedTelegramFileId, parseSignedTelegramFileId } from '../../src/lib/telegram';

describe('signed Telegram file ids', () => {
  it('round-trips file metadata', async () => {
    const id = await createSignedTelegramFileId(
      {
        fileId: 'FILE123',
        fileExtension: 'mp4',
        fileName: 'clip.mp4',
        mimeType: 'video/mp4',
        fileSize: 1234,
        messageId: 7,
      },
      env
    );

    expect(id.startsWith('tgs_')).toBe(true);

    const parsed = await parseSignedTelegramFileId(id, env);
    expect(parsed?.fileId).toBe('FILE123');
    expect(parsed?.fileExtension).toBe('mp4');
    expect(parsed?.fileName).toBe('clip.mp4');
    expect(parsed?.mimeType).toBe('video/mp4');
    expect(parsed?.fileSize).toBe(1234);
    expect(parsed?.messageId).toBe(7);
  });

  it('rejects a tampered signature', async () => {
    const id = await createSignedTelegramFileId(
      {
        fileId: 'FILE456',
        fileExtension: 'bin',
        fileName: 'a.bin',
        mimeType: 'application/octet-stream',
        fileSize: 1,
      },
      env
    );

    const parts = id.split('.');
    const signature = parts[1];
    parts[1] = `${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`;

    expect(await parseSignedTelegramFileId(parts.join('.'), env)).toBeNull();
  });

  it('falls back to the bot token as signing secret', async () => {
    const localEnv = {
      TG_Bot_Token: '123:test-token',
      TG_Chat_ID: '-1001234567890',
    } as Env;

    const id = await createSignedTelegramFileId(
      {
        fileId: 'FILE789',
        fileExtension: 'txt',
        fileName: 'note.txt',
        mimeType: 'text/plain',
        fileSize: 2,
      },
      localEnv
    );

    const parsed = await parseSignedTelegramFileId(id, localEnv);
    expect(parsed?.fileId).toBe('FILE789');
  });
});
