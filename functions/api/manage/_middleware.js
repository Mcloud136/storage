import { checkAuthentication, isAuthRequired } from '../../utils/auth.js';

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

async function errorHandling(context) {
  try {
    return await context.next();
  } catch (error) {
    console.error('manage middleware error:', error?.message || error);
    return jsonResponse({ success: false, error: 'Internal Server Error' }, 500);
  }
}

async function authentication(context) {
  const { env, request } = context;

  if (!env?.img_url) {
    return jsonResponse({ success: false, error: 'KV_NOT_CONFIGURED' }, 503);
  }

  // `/api/manage/login` 只做 302 跳转，保留给 gallery 的未登录跳转使用。
  if (new URL(request.url).pathname === '/api/manage/login') {
    return context.next();
  }

  if (!isAuthRequired(env)) {
    return jsonResponse({ success: false, error: 'ADMIN_NOT_CONFIGURED' }, 503);
  }

  const authResult = await checkAuthentication(context);
  if (!authResult.authenticated) {
    return jsonResponse({ success: false, error: 'UNAUTHORIZED' }, 401);
  }

  return context.next();
}

export const onRequest = [errorHandling, authentication];
