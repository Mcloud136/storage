import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { candidateKeys, inferStorageType, parseKey } from '../../src/core/keys';
import { getRecordWithKey } from '../../src/core/kv';

describe('candidateKeys', () => {
  it('tries the bare key first for telegram file ids', () => {
    const keys = candidateKeys('BQACAgUAAyEFAATfemyn.mp4');
    expect(keys[0]).toBe('BQACAgUAAyEFAATfemyn.mp4');
    expect(keys).toContain('img:BQACAgUAAyEFAATfemyn.mp4');
    expect(keys).toContain('webdav:BQACAgUAAyEFAATfemyn.mp4');
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('uses prefixed keys directly', () => {
    expect(candidateKeys('webdav:abc.bin')).toEqual(['webdav:abc.bin']);
    expect(candidateKeys('hf:abc.bin')).toEqual(['hf:abc.bin']);
  });
});

describe('storage type inference', () => {
  it('prefers metadata over the key prefix', () => {
    expect(inferStorageType('img:legacy.png', { storage: 'r2' })).toBe('r2');
    expect(inferStorageType('hf:file.bin', {})).toBe('huggingface');
    expect(inferStorageType('unknown-id', {})).toBe('telegram');
  });

  it('parses known prefixes', () => {
    expect(parseKey('github:abc.zip')).toBe('abc.zip');
    expect(parseKey('abc.zip')).toBe('abc.zip');
  });
});

describe('getRecordWithKey', () => {
  it('reads a bare telegram record', async () => {
    const id = `BQACtest${Date.now()}.mp4`;
    await env.img_url.put(id, '', {
      metadata: { storageType: 'telegram', fileName: id, TimeStamp: 1 },
    });

    const resolved = await getRecordWithKey(env.img_url, id);
    expect(resolved.kvKey).toBe(id);
    expect(resolved.candidatesTried).toBe(1);
    expect(resolved.record?.metadata?.storageType).toBe('telegram');
  });

  it('reads a prefixed record', async () => {
    const id = `webdavtest${Date.now()}.bin`;
    await env.img_url.put(`webdav:${id}`, '', {
      metadata: { storageType: 'webdav', webdavPath: `uploads/${id}` },
    });

    const resolved = await getRecordWithKey(env.img_url, `webdav:${id}`);
    expect(resolved.kvKey).toBe(`webdav:${id}`);
    expect(resolved.record?.metadata?.webdavPath).toBe(`uploads/${id}`);
  });
});
