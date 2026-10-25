/**
 * 登录 API
 * POST /api/auth/login
 */
import { 
  createSession, 
  createSessionCookieHeader,
  isAuthRequired 
} from '../../utils/auth.js';

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    // 未配置管理员账号时后台整体 fail-closed，不再返回“无需登录”。
    if (!isAuthRequired(env)) {
      return new Response(JSON.stringify({
        success: false,
        error: 'ADMIN_NOT_CONFIGURED',
        message: '管理员账号未配置，请先设置 BASIC_USER 与 BASIC_PASS。'
      }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const body = await request.json();
    const username = String(body?.username ?? body?.user ?? '').trim();
    const password = String(body?.password ?? body?.pass ?? '');

    if (!username || password === '') {
      return new Response(JSON.stringify({
        success: false,
        message: 'Missing username or password.'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 验证凭据
    if (username === env.BASIC_USER && password === env.BASIC_PASS) {
      // 创建会话
      const sessionToken = await createSession(username, env);
      
      return new Response(JSON.stringify({ 
        success: true, 
        message: '登录成功' 
      }), {
        headers: { 
          'Content-Type': 'application/json',
          'Set-Cookie': createSessionCookieHeader(
            sessionToken,
            undefined,
            new URL(request.url).protocol === 'https:'
          )
        }
      });
    }

    return new Response(JSON.stringify({ 
      success: false, 
      message: '用户名或密码错误' 
    }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Login error:', error);
    return new Response(JSON.stringify({ 
      success: false, 
      message: '登录失败：' + error.message 
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// 检查登录状态
export async function onRequestGet(context) {
  const { env } = context;
  
  return new Response(JSON.stringify({
    // 纵深防御：显式布尔化，防止上游返回非布尔值时把敏感值序列化出去
    authRequired: Boolean(isAuthRequired(env))
  }), {
    headers: { 'Content-Type': 'application/json' }
  });
}
