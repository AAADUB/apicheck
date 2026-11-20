// API Check Worker: the JSON API under /api, the interface from the ASSETS binding, a one-minute cron that keeps every watch's loop alive,
// and the Watcher Durable Object that runs the loops.
// No runtime dependencies: a service that holds other people's cloud keys should carry as little third-party code as possible.
import {json, bad, HttpError} from './http';
import type {Route, User} from './http';
import {authRoutes, currentUser} from './auth';
import {appRoutes, poke} from './app';
import type {Env} from './types';
export {Watcher} from './watcher';

const routes: Route[] = [...authRoutes, ...appRoutes];

async function api(req: Request, env: Env, exec: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  try {
    if (req.method !== 'GET') {
      // CSRF: the cookie is SameSite=Lax; a custom header forces a preflight cross-origin; the Origin must be ours when present
      const origin = req.headers.get('origin');
      if (req.headers.get('x-apicheck') !== '1' || (origin && origin !== url.origin)) bad('csrf', 403);
    }
    for (const [method, re, handler, auth] of routes) {
      const m = req.method === method && url.pathname.match(re); if (!m) continue;
      const user = auth === false ? null : await currentUser(req, env);
      if (auth !== false && !user) bad('auth', 401);
      if (auth === 'admin' && user!.role !== 'admin') bad('forbidden', 403);
      let body: any = {};
      if (req.method !== 'GET' && req.method !== 'DELETE') {
        if (Number(req.headers.get('content-length') || 0) > 80000) bad('too_large', 413);
        const text = await req.text(); if (text.length > 80000) bad('too_large', 413);
        try { body = text ? JSON.parse(text) : {}; } catch { bad('json'); }
        if (!body || typeof body !== 'object') bad('json');
      }
      return await handler({req, env, url, user: user as User, params: m.slice(1), exec, body});
    }
    return json({error: 'not_found'}, 404);
  } catch (e) {
    if (e instanceof HttpError) return json({error: e.code, ...(e.extra || {})}, e.status);
    console.error('api', url.pathname, (e as Error).message);
    return json({error: 'server'}, 500);
  }
}

export default {
  async fetch(req: Request, env: Env, exec: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) return api(req, env, exec);
    // the workspace is private: every page, file and fallback says so to search engines, whatever the static headers do
    const res = await env.ASSETS.fetch(req), out = new Response(res.body, res);
    out.headers.set('x-robots-tag', 'noindex, nofollow, noarchive, nosnippet, noimageindex');
    return out;
  },
  /* Every minute: wake the loop of every key that has a running watch (an alarm can be lost when an object is moved), and once an hour tidy old rows. */
  async scheduled(ev: ScheduledController, env: Env, exec: ExecutionContext) {
    exec.waitUntil((async () => {
      const keys = (await env.DB.prepare("SELECT DISTINCT w.key_id FROM watches w JOIN keys k ON k.id = w.key_id WHERE w.state = 'on' AND k.status = 'ok'").all<{key_id: string}>()).results;
      await Promise.all(keys.map(k => poke(env, k.key_id)));
      if (new Date(ev.scheduledTime).getUTCMinutes() === 7) {
        const now = Date.now(), d = 86400e3;
        await env.DB.batch([
          env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
          env.DB.prepare('DELETE FROM invites WHERE expires_at < ?').bind(now - 30 * d),
          env.DB.prepare('DELETE FROM events WHERE at < ?').bind(now - 120 * d),
          env.DB.prepare('DELETE FROM windows WHERE end_at IS NOT NULL AND end_at < ?').bind(now - 120 * d),
          env.DB.prepare('DELETE FROM notices WHERE at < ?').bind(now - 180 * d)
        ]);
      }
    })());
  }
} satisfies ExportedHandler<Env>;
