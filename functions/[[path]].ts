import app from '../src/app';
import type { Env } from '../src/env';

type PagesContext = {
  request: Request;
  env: Env;
  waitUntil(promise: Promise<unknown>): void;
};

const PAGE_REWRITES: Record<string, string> = {
  '/': '/index.html',
  '/admin': '/admin.html',
  '/gallery': '/gallery.html',
  '/login': '/login.html',
  '/preview': '/preview.html',
  '/webdav': '/webdav.html',
  '/block-img': '/block-img.html',
  '/whitelist-on': '/whitelist-on.html',
};

export const onRequest = (context: PagesContext) => {
  const url = new URL(context.request.url);
  const target = PAGE_REWRITES[url.pathname];
  if (target) {
    return context.env.ASSETS.fetch(new Request(new URL(target, url), context.request));
  }
  return app.fetch(context.request, context.env, context as unknown as ExecutionContext);
};
