// One way to call a provider: a timeout, an honest User-Agent, JSON in and out, and errors sorted into kinds.
import {ProviderError} from '../types';
import type {Ctx, FailKind} from '../types';

export const UA = 'APICheck/1.0 (+https://github.com/AAADUB/apicheck)';
export type Classify = (status: number, body: any, text: string) => FailKind | null;

/** a request whose answer is unclear (network failure or timeout) is marked, so a launch is never repeated blindly */
export class Unclear extends ProviderError { constructor(message: string) { super('http', message); this.name = 'Unclear'; } }

export async function call(c: Ctx, url: string, init: RequestInit & {timeout?: number; memo?: boolean} = {}, classify?: Classify): Promise<any> {
  const key = init.memo ? (init.method || 'GET') + ' ' + url : '';
  const memo: Map<string, Promise<any>> | undefined = (c as any).memo;
  if (key && memo && memo.has(key)) return memo.get(key);
  const run = (async () => {
    let res: Response;
    try {
      res = await c.fetch(url, {...init, headers: {'user-agent': UA, accept: 'application/json', ...(init.body && typeof init.body === 'string' ? {'content-type': 'application/json'} : {}), ...(init.headers as Record<string, string> || {})}, signal: AbortSignal.timeout(init.timeout || 20000)});
    } catch (e) { throw new Unclear('No answer from the provider (' + ((e as Error).name === 'TimeoutError' ? 'timed out' : 'network error') + ').'); }
    const text = await res.text();
    let body: any = null; try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    if (res.ok) return body;
    const kind = (classify && classify(res.status, body, text)) || defaultKind(res.status);
    const ra = Number(res.headers.get('retry-after')) || 0;
    throw new ProviderError(kind, messageOf(body, text, res.status), res.status, ra);
  })();
  if (key && memo) { memo.set(key, run); run.catch(() => memo.delete(key)); }
  return run;
}
export function defaultKind(status: number): FailKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate';
  if (status === 402) return 'money';
  if (status >= 500 || status === 0) return 'http';
  return 'invalid';
}
/* a short, readable message from whatever error shape the provider uses */
export function messageOf(body: any, text: string, status: number): string {
  const pick = (v: any): string => (typeof v === 'string' ? v : v && typeof v === 'object' ? (v.message || v.error_message || v.detail || v.error || '') : '');
  let m = '';
  if (body) m = pick(body.error) || pick(body) || (Array.isArray(body.errors) ? body.errors.map(pick).filter(Boolean).join('; ') : '');
  if (!m) m = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  return (m || 'HTTP ' + status).slice(0, 400);
}
export const round2 = (n: number) => Math.round(n * 100) / 100;
export const gib2gb = (g: number) => Math.round(g * 1.073741824);
