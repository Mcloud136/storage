import type { Env } from '../env';

function getClientIp(request: Request): string {
  return (
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
    request.headers.get('X-Real-IP') ||
    '0.0.0.0'
  );
}

function getTodayKey(): string {
  return new Date().toISOString().split('T')[0];
}

export interface GuestConfig {
  enabled: boolean;
  maxFileSize: number;
  dailyLimit: number;
}

export function getGuestConfig(env: Env): GuestConfig {
  const enabled = env.GUEST_UPLOAD === 'true';
  return {
    enabled,
    maxFileSize: enabled ? (parseInt(env.GUEST_MAX_FILE_SIZE || '', 10) || 5 * 1024 * 1024) : 0,
    dailyLimit: enabled ? (parseInt(env.GUEST_DAILY_LIMIT || '', 10) || 10) : 0,
  };
}

export async function checkGuestUpload(
  request: Request,
  env: Env,
  fileSize: number
): Promise<{ allowed: boolean; reason?: string; status?: number; remaining?: number }> {
  const config = getGuestConfig(env);
  if (!config.enabled) {
    return { allowed: false, reason: '未启用访客上传，请登录后操作', status: 401 };
  }

  if (fileSize > config.maxFileSize) {
    const maxMB = (config.maxFileSize / 1024 / 1024).toFixed(0);
    return {
      allowed: false,
      reason: `访客上传限制：文件大小不能超过 ${maxMB}MB`,
      status: 413,
    };
  }

  if (!env.img_url) {
    return { allowed: true };
  }

  const ip = getClientIp(request);
  const today = getTodayKey();
  const key = `guest:${ip}:${today}`;

  try {
    const current = parseInt((await env.img_url.get(key)) || '0', 10) || 0;
    if (current >= config.dailyLimit) {
      return {
        allowed: false,
        reason: `访客每日上传上限 ${config.dailyLimit} 次，今日已用完`,
        status: 429,
        remaining: 0,
      };
    }
    return { allowed: true, remaining: config.dailyLimit - current };
  } catch {
    return { allowed: true };
  }
}

export async function incrementGuestCount(request: Request, env: Env): Promise<void> {
  if (!env.img_url || env.GUEST_UPLOAD !== 'true') return;

  const ip = getClientIp(request);
  const today = getTodayKey();
  const key = `guest:${ip}:${today}`;

  try {
    const current = parseInt((await env.img_url.get(key)) || '0', 10) || 0;
    await env.img_url.put(key, String(current + 1));
  } catch {
    // Guest counters are best-effort; never fail an upload on counter errors.
  }
}
