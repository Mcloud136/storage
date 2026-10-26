import { Hono } from 'hono';
import type { Env } from '../env';
import { json } from '../lib/http';

interface BingImage {
  url?: string;
  urlbase?: string;
  copyright?: string;
  title?: string;
}

interface BingResponse {
  images?: BingImage[];
}

async function wallpaperHandler(): Promise<Response> {
  try {
    const response = await fetch('https://cn.bing.com/HPImageArchive.aspx?format=js&idx=0&n=5');
    if (!response.ok) {
      return json({ status: false, message: `Bing returned ${response.status}`, data: [] }, 502);
    }
    const payload = (await response.json()) as BingResponse;
    return json({
      status: true,
      message: '操作成功',
      data: Array.isArray(payload.images) ? payload.images : [],
    });
  } catch (error) {
    return json(
      {
        status: false,
        message: error instanceof Error ? error.message : 'Bing request failed',
        data: [],
      },
      502
    );
  }
}

export const bingRoutes = new Hono<{ Bindings: Env }>();

bingRoutes.get('/api/bing/wallpaper', wallpaperHandler);
bingRoutes.get('/api/bing/wallpaper/', wallpaperHandler);
