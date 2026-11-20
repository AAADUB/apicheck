// Shared pieces of the JSON API: errors, responses, the request context and the route table type.
import type {Env} from './types';

export const DAY = 86400e3;
export type User = {id: string; email: string; role: string; alert_mail: number; notify_email: string; pass_hash: string};
export type Ctx = {req: Request; env: Env; url: URL; user: User; params: string[]; exec: ExecutionContext; body: any};
export type Handler = (c: Ctx) => Promise<Response> | Response;
/** the fourth field: false = no session needed, 'admin' = administrators only, absent = any signed-in user */
export type Route = [string, RegExp, Handler, (false | 'admin')?];

export class HttpError extends Error { constructor(public status: number, public code: string, public extra?: Record<string, unknown>) { super(code); } }
export const json = (data: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(data), {status, headers: {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex, nofollow, noarchive, nosnippet, noimageindex', 'strict-transport-security': 'max-age=63072000; includeSubDomains', ...headers}});
export const bad = (code: string, status = 400, extra?: Record<string, unknown>): never => { throw new HttpError(status, code, extra); };
export const mailOk = (v: unknown): v is string => typeof v === 'string' && v.length <= 254 && /^[\x21-\x7e]+$/.test(v) && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
export const passOk = (v: unknown): v is string => typeof v === 'string' && v.length >= 8 && v.length <= 200;
export const audit = (env: Env, uid: string | null, action: string, detail = '') => env.DB.prepare('INSERT INTO audit (user_id, at, action, detail) VALUES (?, ?, ?, ?)').bind(uid, Date.now(), action, detail.slice(0, 300));
export const ipOf = (c: Ctx) => c.req.headers.get('cf-connecting-ip') || '';
/* The limiter is a binding declared in wrangler.jsonc. Each sign-in attempt costs a password hash, so both the address and the address-plus-email pair are counted. */
export async function limited(env: Env, ...keys: string[]) { if (env.LOGIN_LIMIT) for (const key of keys) if (!(await env.LOGIN_LIMIT.limit({key})).success) bad('slow_down', 429); }
/** plain text of at most n characters, with control characters turned into spaces */
export const clean = (v: unknown, n: number) => String(v ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]+/g, ' ').trim().slice(0, n);
