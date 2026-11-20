// Who can get in. The workspace is closed: nobody signs up. The first administrator is created once with the SETUP_TOKEN secret
// (or by a one-time link issued at deployment), administrators create users, and every user sets a password through a one-time link.
// The same mechanism as API Balance, so both tools behave alike.
import {hashPassword, verifyPassword, burnPassword, newToken, tokenHash, sameSecret, newId} from './crypto';
import {json, bad, mailOk, passOk, audit, ipOf, limited, clean, DAY} from './http';
import type {Ctx, Route, User} from './http';
import type {Env} from './types';

export const COOKIE = '__Host-apicheck';
const SESSION_MS = 30 * DAY, MAX_USERS = 200, SETUP_MIN = 32;
const LINK_MS = {user: 7 * DAY, admin: DAY};
const cookie = (token: string, maxAge: number) => `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
const cookieToken = (req: Request) => ((req.headers.get('cookie') || '').match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([\\w-]+)')) || [])[1] || '';

export async function currentUser(req: Request, env: Env): Promise<User | null> {
  const t = cookieToken(req); if (!t) return null;
  return env.DB.prepare('SELECT u.id, u.email, u.role, u.alert_mail, u.notify_email, u.pass_hash FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ? AND s.expires_at > ? AND u.disabled = 0').bind(await tokenHash(t), Date.now()).first<User>();
}
/* The session row is written only if, at that moment, the user is not blocked and still has the password that was just checked. */
async function startSession(env: Env, uid: string, hash: string): Promise<string> {
  const token = newToken(), now = Date.now();
  const r = await env.DB.prepare("INSERT INTO sessions (id_hash, user_id, created_at, expires_at) SELECT ?, id, ?, ? FROM users WHERE id = ? AND disabled = 0 AND pass_hash = ? AND pass_hash != ''").bind(await tokenHash(token), now, now + SESSION_MS, uid, hash).run();
  if (!r.meta.changes) bad('credentials', 401);
  await env.DB.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').bind(now, uid).run();
  return cookie(token, SESSION_MS / 1000);
}
/* A one-time link: the token goes to the administrator once, only its hash is stored, and a new link replaces the old one. */
export async function issueLink(env: Env, uid: string, kind: 'invite' | 'reset', role: string, ms?: number) {
  const token = newToken(), now = Date.now(), until = now + (ms || (role === 'admin' ? LINK_MS.admin : LINK_MS.user));
  await env.DB.batch([env.DB.prepare('DELETE FROM invites WHERE user_id = ?').bind(uid), env.DB.prepare('INSERT INTO invites (token_hash, user_id, kind, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').bind(await tokenHash(token), uid, kind, now, until)]);
  return {invite: token, expires: until};
}
const linkOwner = async (env: Env, token: unknown) => (typeof token === 'string' && /^[\w-]{20,100}$/.test(token)
  ? env.DB.prepare('SELECT u.id, u.email, i.kind FROM invites i JOIN users u ON u.id = i.user_id WHERE i.token_hash = ? AND i.expires_at > ? AND u.disabled = 0').bind(await tokenHash(token), Date.now()).first<{id: string; email: string; kind: string}>() : null);
/* Every change to another user is one statement that also checks the actor is, at that moment, still an administrator who can sign in. */
const ACTOR_OK = " AND EXISTS (SELECT 1 FROM users o WHERE o.id = ? AND o.role = 'admin' AND o.disabled = 0 AND o.pass_hash != '')";
/* blocking or deleting a person stops their watches at once */
const stopWatchesOf = (env: Env, uid: string, why: string) => env.DB.prepare("UPDATE watches SET state = 'stopped', stop_reason = ?, updated_at = ? WHERE user_id = ? AND state = 'on'").bind(why, Date.now(), uid);

export const authRoutes: Route[] = [
  ['GET', /^\/api\/auth\/state$/, async c => json({setup: (c.env.SETUP_TOKEN || '').length >= SETUP_MIN && !(await c.env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<number>('n'))}), false],
  /* First run: whoever holds SETUP_TOKEN creates the first administrator. Later the same secret only sets a new password for an existing administrator. */
  ['POST', /^\/api\/auth\/setup$/, async c => {
    const {token, email, password} = c.body, db = c.env.DB;
    await limited(c.env, 'setup:' + ipOf(c));
    if (!c.env.SETUP_TOKEN || c.env.SETUP_TOKEN.length < SETUP_MIN) bad('not_found', 404);
    if (typeof token !== 'string' || !sameSecret(await tokenHash(token), await tokenHash(c.env.SETUP_TOKEN!))) bad('setup_token', 403);
    if (!mailOk(email)) bad('email'); if (!passOk(password)) bad('password');
    const hash = await hashPassword(password), now = Date.now(); let id = newId('usr'), action = 'setup';
    const first = await db.prepare("INSERT INTO users (id, email, pass_hash, role, created_at) SELECT ?, ?, ?, 'admin', ? WHERE NOT EXISTS (SELECT 1 FROM users)").bind(id, email.trim(), hash, now).run();
    if (!first.meta.changes) {
      const u = await db.prepare("SELECT id FROM users WHERE email = ? AND role = 'admin' AND disabled = 0").bind(email.trim()).first<{id: string}>();
      if (!u) bad('setup_done', 409);
      id = u!.id; action = 'admin_recover';
      await db.batch([db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').bind(hash, id), db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id), db.prepare('DELETE FROM invites WHERE user_id = ?').bind(id)]);
    }
    await audit(c.env, id, action).run();
    return json({ok: true}, 201, {'set-cookie': await startSession(c.env, id, hash)});
  }, false],
  ['POST', /^\/api\/auth\/invite$/, async c => {
    await limited(c.env, 'invite:' + ipOf(c));
    const u = await linkOwner(c.env, c.body.token); if (!u) bad('invite', 404);
    return json({email: u!.email, kind: u!.kind});
  }, false],
  ['POST', /^\/api\/auth\/accept$/, async c => {
    await limited(c.env, 'invite:' + ipOf(c));
    const u = await linkOwner(c.env, c.body.token), db = c.env.DB; if (!u) bad('invite', 404);
    if (!passOk(c.body.password)) bad('password');
    const hash = await hashPassword(c.body.password);
    const used = await db.prepare('DELETE FROM invites WHERE user_id = ? AND token_hash = ?').bind(u!.id, await tokenHash(c.body.token)).run();
    if (!used.meta.changes) bad('invite', 404);
    await db.batch([db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').bind(hash, u!.id), db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(u!.id), audit(c.env, u!.id, 'link_used', u!.kind)]);
    return json({ok: true}, 201, {'set-cookie': await startSession(c.env, u!.id, hash)});
  }, false],
  ['POST', /^\/api\/auth\/login$/, async c => {
    const {email, password} = c.body;
    if (!mailOk(email) || typeof password !== 'string' || password.length > 200) bad('credentials', 401);
    const ip = ipOf(c);
    await limited(c.env, 'ip:' + ip, 'login:' + email.toLowerCase() + ':' + ip);
    const u = await c.env.DB.prepare('SELECT id, pass_hash, disabled FROM users WHERE email = ?').bind(email.trim()).first<{id: string; pass_hash: string; disabled: number}>();
    const can = !!u && !!u.pass_hash && !u.disabled, ok = can ? await verifyPassword(password, u!.pass_hash) : await burnPassword(password);
    if (!can || !ok) { await audit(c.env, u ? u.id : null, 'login_failed').run(); bad('credentials', 401); }
    return json({ok: true}, 200, {'set-cookie': await startSession(c.env, u!.id, u!.pass_hash)});
  }, false],
  ['POST', /^\/api\/auth\/logout$/, async c => {
    const t = cookieToken(c.req);
    if (t) await c.env.DB.prepare('DELETE FROM sessions WHERE id_hash = ?').bind(await tokenHash(t)).run();
    return json({ok: true}, 200, {'set-cookie': cookie('', 0)});
  }, false],
  ['PATCH', /^\/api\/me$/, async c => {
    const b = c.body, set: string[] = [], val: unknown[] = [];
    if (b.email !== undefined || b.password !== undefined) {
      if (b.email !== undefined && c.user.role !== 'admin') bad('forbidden', 403);
      await limited(c.env, 'me:' + c.user.id);
      if (typeof b.current !== 'string' || !(await verifyPassword(b.current, c.user.pass_hash))) bad('current_password', 403);
      if (b.email !== undefined) { if (!mailOk(b.email)) bad('email'); set.push('email = ?'); val.push(b.email.trim()); }
      if (b.password !== undefined) { if (!passOk(b.password)) bad('password'); set.push('pass_hash = ?'); val.push(await hashPassword(b.password)); }
    }
    if (b.mail !== undefined) { set.push('alert_mail = ?'); val.push(b.mail ? 1 : 0); }
    // Only an administrator may send alerts to an address other than the sign-in one: an address is not confirmed by its owner.
    if (b.notifyEmail !== undefined) { if (c.user.role !== 'admin') bad('forbidden', 403); const m = String(b.notifyEmail ?? '').trim(); if (m && !mailOk(m)) bad('email'); set.push('notify_email = ?'); val.push(m.toLowerCase() === c.user.email.toLowerCase() ? '' : m); }
    if (!set.length) bad('empty');
    let done = 0;
    try { done = (await c.env.DB.prepare(`UPDATE users SET ${set.join(', ')} WHERE id = ? AND pass_hash = ?`).bind(...val, c.user.id, c.user.pass_hash).run()).meta.changes; } catch { bad('email_taken', 409); }
    if (!done) bad('current_password', 403);
    if (b.password !== undefined) await c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND id_hash != ?').bind(c.user.id, await tokenHash(cookieToken(c.req))).run();
    return json({ok: true});
  }],

  /* ---------- administration: who may use the workspace. An administrator never sees another user's keys, watches or machines. ---------- */
  ['GET', /^\/api\/admin\/users$/, async c => {
    const now = Date.now(), r = await c.env.DB.prepare(`SELECT u.id, u.email, u.role, u.disabled, u.note, u.created_at, u.last_login_at, u.pass_hash != '' AS has_pass,
      (SELECT COUNT(*) FROM watches w WHERE w.user_id = u.id) AS watches, (SELECT expires_at FROM invites i WHERE i.user_id = u.id) AS link_until FROM users u ORDER BY u.created_at, u.id LIMIT ?`).bind(MAX_USERS).all<any>();
    return json({items: r.results.map(u => ({id: u.id, email: u.email, role: u.role, note: u.note, watches: u.watches, createdAt: u.created_at, lastLogin: u.last_login_at, me: u.id === c.user.id,
      status: u.disabled ? 'blocked' : u.has_pass ? 'active' : u.link_until > now ? 'invited' : 'expired', linkUntil: !u.has_pass && u.link_until > now ? u.link_until : null}))});
  }, 'admin'],
  ['POST', /^\/api\/admin\/users$/, async c => {
    const b = c.body, db = c.env.DB; if (!mailOk(b.email)) bad('email');
    const id = newId('usr'), role = b.role === 'admin' ? 'admin' : 'user', note = clean(b.note, 120);
    const r = await db.prepare('INSERT OR IGNORE INTO users (id, email, role, note, created_at, created_by) SELECT ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM users) < ?').bind(id, b.email.trim(), role, note, Date.now(), c.user.id, MAX_USERS).run();
    if (!r.meta.changes) bad((await db.prepare('SELECT 1 AS x FROM users WHERE email = ?').bind(b.email.trim()).first()) ? 'email_taken' : 'user_limit', 409);
    await audit(c.env, c.user.id, 'user_create', id + ' ' + role).run();
    return json({id, ...(await issueLink(c.env, id, 'invite', role))}, 201);
  }, 'admin'],
  ['POST', /^\/api\/admin\/users\/([\w-]+)\/link$/, async c => {
    const db = c.env.DB, u = await db.prepare('SELECT id, role, pass_hash, disabled FROM users WHERE id = ?').bind(c.params[0]).first<{id: string; role: string; pass_hash: string; disabled: number}>();
    if (!u) bad('not_found', 404); if (u!.id === c.user.id) bad('self', 409);
    if (u!.disabled) bad('blocked', 409);
    const r = await db.prepare("UPDATE users SET pass_hash = '' WHERE id = ? AND disabled = 0" + ACTOR_OK).bind(u!.id, c.user.id).run();
    if (!r.meta.changes) bad('forbidden', 403);
    await db.batch([db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(u!.id), audit(c.env, c.user.id, 'user_link', u!.id)]);
    return json(await issueLink(c.env, u!.id, u!.pass_hash ? 'reset' : 'invite', u!.role), 201);
  }, 'admin'],
  ['PATCH', /^\/api\/admin\/users\/([\w-]+)$/, async c => {
    const db = c.env.DB, b = c.body, u = await db.prepare('SELECT id FROM users WHERE id = ?').bind(c.params[0]).first<{id: string}>(), set: string[] = [], val: unknown[] = [];
    if (!u) bad('not_found', 404);
    if (u!.id === c.user.id && (b.disabled !== undefined || b.role !== undefined)) bad('self', 409);
    if (b.disabled !== undefined) { set.push('disabled = ?'); val.push(b.disabled ? 1 : 0); }
    if (b.role !== undefined) { if (b.role !== 'admin' && b.role !== 'user') bad('role'); set.push('role = ?'); val.push(b.role); }
    if (b.note !== undefined) { set.push('note = ?'); val.push(clean(b.note, 120)); }
    if (b.email !== undefined) { if (!mailOk(b.email)) bad('email'); set.push('email = ?'); val.push(b.email.trim()); }
    if (!set.length) bad('empty');
    let r; try { r = await db.prepare(`UPDATE users SET ${set.join(', ')} WHERE id = ?${ACTOR_OK}`).bind(...val, u!.id, c.user.id).run(); } catch { bad('email_taken', 409); }
    if (!r!.meta.changes) bad('forbidden', 403);
    const st = [audit(c.env, c.user.id, 'user_change', u!.id + ' ' + Object.keys(b).filter(k => ['disabled', 'role', 'note', 'email'].includes(k)).join(','))];
    if (b.disabled !== undefined) st.push(db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(u!.id), db.prepare('DELETE FROM invites WHERE user_id = ?').bind(u!.id));
    if (b.disabled) st.push(stopWatchesOf(c.env, u!.id, 'The person was blocked by an administrator.'));
    await db.batch(st);
    return json({ok: true});
  }, 'admin'],
  ['DELETE', /^\/api\/admin\/users\/([\w-]+)$/, async c => {
    const db = c.env.DB, u = await db.prepare('SELECT id FROM users WHERE id = ?').bind(c.params[0]).first<{id: string}>();
    if (!u) bad('not_found', 404); if (u!.id === c.user.id) bad('self', 409);
    const r = await db.prepare('DELETE FROM users WHERE id = ?' + ACTOR_OK).bind(u!.id, c.user.id).run();
    if (!r.meta.changes) bad('forbidden', 403);
    await audit(c.env, c.user.id, 'user_delete', u!.id).run();
    return json({ok: true});
  }, 'admin']
];
