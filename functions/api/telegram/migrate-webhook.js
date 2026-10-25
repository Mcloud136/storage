/**
 * TEMPORARY one-shot migration endpoint.
 * Removed immediately after the Telegram webhook is updated.
 * Protected by a one-time key hash; the bot token never leaves the Worker.
 */
const KEY_HASH = '1ecde6ff9e32817a270216ad6e41368231083e380ec6c13a653a9023357261f1';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(String(value || ''))
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const key = request.headers.get('x-migration-key') || '';
  if (!key || (await sha256Hex(key)) !== KEY_HASH) {
    return json({ ok: false, error: 'Not found' }, 404);
  }

  const token = String(env.TG_Bot_Token || '').trim();
  if (!token) {
    return json({ ok: false, error: 'TG_Bot_Token is not configured' }, 500);
  }

  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const base = `https://api.telegram.org/bot${token}`;

  if (body.action === 'info') {
    const response = await fetch(`${base}/getWebhookInfo`);
    const data = await response.json().catch(() => ({}));
    return json({
      ok: Boolean(data.ok),
      url: data.result?.url || '',
      pending: data.result?.pending_update_count || 0,
      lastError: data.result?.last_error_message || '',
    });
  }

  const url = String(body.url || '');
  const secret = String(body.secret || '');
  if (!url.startsWith('https://') || secret.length < 16) {
    return json({ ok: false, error: 'Invalid params' }, 400);
  }

  const response = await fetch(`${base}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url,
      secret_token: secret,
      allowed_updates: ['message', 'channel_post'],
    }),
  });
  const data = await response.json().catch(() => ({}));
  return json(
    { ok: Boolean(data.ok), description: data.description || '' },
    response.ok ? 200 : 502
  );
}
