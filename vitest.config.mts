import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          BASIC_USER: 'admin',
          BASIC_PASS: 'test-pass',
          GUEST_UPLOAD: 'false',
          TG_Bot_Token: '123:test-token',
          TG_Chat_ID: '-1001234567890',
          FILE_URL_SECRET: 'test-file-secret',
          TELEGRAM_LINK_MODE: 'signed',
          TG_WEBHOOK_SECRET: 'test-webhook-secret',
          TG_UPLOAD_NOTIFY: 'false',
        },
      },
    }),
  ],
  test: {
    include: ['test/v2/**/*.spec.ts'],
  },
});
