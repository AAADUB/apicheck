// Email through Cloudflare Email Service. Every message is logged with its result; a sender never throws.
import type {Env} from './types';

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c] as string));
export const mailReady = (env: Env) => !!(env.EMAIL && env.MAIL_FROM);
export const appLink = (env: Env, hash: string) => (env.APP_URL ? env.APP_URL.replace(/\/+$/, '') + '/#' + hash : '');

/* The text part is the message. The HTML part is the same lines, with only links to this workspace turned into links:
   a configuration or machine name comes from a provider and could look like an address. */
export async function sendEmail(env: Env, to: string, subject: string, text: string): Promise<string> {
  if (!env.EMAIL || !env.MAIL_FROM) return 'off';
  const base = env.APP_URL ? esc(env.APP_URL.replace(/\/+$/, '')) : '';
  const html = `<div style="font:15px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;color:#10151c;max-width:36em">${esc(text).split('\n').map(l => {
    const i = base ? l.indexOf(base + '/#') : -1; return i < 0 ? l : l.slice(0, i) + `<a href="${l.slice(i)}">${l.slice(i)}</a>`;
  }).join('<br>')}</div>`;
  try { await env.EMAIL.send({to, from: {email: env.MAIL_FROM, name: 'API Check'}, subject, text, html}); return 'sent'; }
  catch (e) { const code = String((e as any)?.code || 'error').replace(/[^\w]/g, '').slice(0, 40); console.error('email', code, (e as Error).message); return 'failed:' + code; }
}

type Person = {id: string; email: string; alert_mail: number; notify_email: string; disabled?: number};
/** one message to the owner of a watch, if they have email switched on; logged either way */
export async function tell(env: Env, uid: string, watchId: string | null, kind: string, subject: string, text: string, force = false): Promise<string> {
  const u = await env.DB.prepare('SELECT id, email, alert_mail, notify_email, disabled FROM users WHERE id = ?').bind(uid).first<Person>();
  if (!u || u.disabled) return 'off';
  const result = force || u.alert_mail ? await sendEmail(env, u.notify_email || u.email, subject, text) : 'off';
  await env.DB.prepare('INSERT INTO notices (user_id, watch_id, at, kind, subject, result) VALUES (?, ?, ?, ?, ?, ?)').bind(uid, watchId, Date.now(), kind, subject.slice(0, 200), result).run();
  return result;
}
