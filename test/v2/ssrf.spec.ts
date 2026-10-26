import { describe, expect, it } from 'vitest';
import { fetchRemoteStrict } from '../../src/lib/ssrf';

describe('remote import SSRF guard', () => {
  it('blocks loopback, metadata and private literals', async () => {
    const urls = [
      'http://127.0.0.1:8899/x',
      'http://localhost/x',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.1/x',
      'http://192.168.1.1/x',
      'http://172.16.0.9/x',
    ];

    for (const url of urls) {
      await expect(fetchRemoteStrict(url, 1024)).rejects.toMatchObject({ code: 'SSRF_BLOCKED' });
    }
  });

  it('rejects non-http protocols', async () => {
    await expect(fetchRemoteStrict('ftp://example.com/x', 1024)).rejects.toMatchObject({
      code: 'INVALID_URL',
    });
  });
});
