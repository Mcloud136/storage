import { Hono } from 'hono';
import type { Env } from '../env';
import { json } from '../lib/http';
import { timingSafeEqualString } from '../lib/crypto';
import {
  buildTelegramDirectLink,
  createSignedTelegramFileId,
  getTelegramChatId,
  shouldUseSignedTelegramLinks,
  shouldWriteTelegramMetadata,
  sendTelegramUploadNotice,
} from '../lib/telegram';
import { getTelegramFileFromMessage } from '../lib/telegram-message';

export const telegramWebhookRoutes = new Hono<{ Bindings: Env }>();

function webhookSecret(env: Env): string {
  return String(env.TG_WEBHOOK_SECRET || env.TELEGRAM_WEBHOOK_SECRET || '').trim();
}

telegramWebhookRoutes.post('/api/telegram/webhook', async (c) => {
  const env = c.env;

  if (!env.TG_Bot_Token && !env.TG_BOT_TOKEN) {
    return json({ ok: false, error: 'TG_Bot_Token is not configured.' }, 500);
  }

  const expectedSecret = webhookSecret(env);
  if (!expectedSecret) {
    return json({ ok: false, error: 'TG_WEBHOOK_SECRET is not configured.' }, 503);
  }

  const providedSecret = c.req.header('X-Telegram-Bot-Api-Secret-Token') || '';
  if (!timingSafeEqualString(providedSecret, expectedSecret)) {
    return json({ ok: false, error: 'Invalid webhook secret.' }, 401);
  }

  const update = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const message = (update.message || update.channel_post) as Record<string, unknown> | undefined;
  if (!message) {
    return json({ ok: true, ignored: 'no-message' });
  }

  const media = getTelegramFileFromMessage(message);
  if (!media) {
    return json({ ok: true, ignored: 'message-without-file' });
  }

  const chat = (message.chat || {}) as Record<string, unknown>;
  const expectedChat = getTelegramChatId(env);
  const chatMatches = expectedChat.startsWith('@')
    ? String(chat.username || '').toLowerCase() === expectedChat.slice(1).toLowerCase()
    : String(chat.id ?? '') === expectedChat;
  if (!expectedChat || !chatMatches) {
    return json({ ok: true, ignored: 'chat-mismatch' });
  }

  const useSigned = shouldUseSignedTelegramLinks(env);
  const directId = useSigned
    ? await createSignedTelegramFileId(
        {
          fileId: media.fileId,
          fileExtension: media.fileExtension,
          fileName: media.fileName,
          mimeType: media.mimeType,
          fileSize: media.fileSize,
          messageId: media.messageId,
        },
        env
      )
    : `${media.fileId}.${media.fileExtension}`;

  if (env.img_url && shouldWriteTelegramMetadata(env)) {
    await env.img_url.put(`${media.fileId}.${media.fileExtension}`, '', {
      metadata: {
        TimeStamp: Date.now(),
        ListType: 'None',
        Label: 'None',
        liked: false,
        fileName: media.fileName,
        fileSize: media.fileSize,
        storageType: 'telegram',
        telegramFileId: media.fileId,
        telegramMessageId: media.messageId || undefined,
        fromWebhook: true,
        signedLink: useSigned,
      },
    });
  }

  const directLink = buildTelegramDirectLink(env, directId, new URL(c.req.url).origin);
  const notice = await sendTelegramUploadNotice(
    {
      chatId: expectedChat,
      replyToMessageId: media.messageId,
      directLink,
      fileId: media.fileId,
      messageId: media.messageId,
      fileName: media.fileName,
      fileSize: media.fileSize,
    },
    env
  );

  return json({
    ok: true,
    directLink,
    storageType: 'telegram',
    mode: useSigned ? 'signed' : 'kv',
    reply: {
      attempted: !notice.skipped,
      ok: Boolean(notice.ok),
      skipped: Boolean(notice.skipped),
      reason: notice.reason || '',
    },
  });
});
