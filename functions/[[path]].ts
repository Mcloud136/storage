import app from '../src/app';
import type { Env } from '../src/env';

type PagesContext = {
  request: Request;
  env: Env;
  waitUntil(promise: Promise<unknown>): void;
};

export const onRequest = (context: PagesContext) =>
  app.fetch(context.request, context.env, context as unknown as ExecutionContext);
