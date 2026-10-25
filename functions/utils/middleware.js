/**
 * 全局错误处理。
 *
 * 遥测已移除：不再加载 Sentry，也不再上报请求头（此前会把 Authorization /
 * Cookie 一并发到第三方 DSN）。保留同名导出，避免改动所有调用方。
 */

export async function errorHandling(context) {
  try {
    return await context.next();
  } catch (error) {
    console.error('Unhandled error:', error?.message || error);
    return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      },
    });
  }
}

export function telemetryData(context) {
  return context.next();
}

export async function traceData() {
  // Telemetry is intentionally disabled.
}
