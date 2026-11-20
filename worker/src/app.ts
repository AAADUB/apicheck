// The workspace API: keys, catalogues, watches, what happened, machines started, notifications.
// Every route reads and writes only the signed-in person's rows.
import {sealKey, openKey, newId} from './crypto';
import {json, bad, clean, mailOk, limited, audit} from './http';
import type {Ctx, Route} from './http';
import type {Env} from './types';
import {ProviderError} from './types';
import {PROVIDERS as ADAPTERS} from './providers';
import {mailReady, tell} from './notify';
import {preflight} from './preflight';
import {LIMITS, EVERY_MAX, providerOf, cleanLaunch, PARAMS} from '../../shared/providers.js';

const MAX_KEYS = 50, MAX_WATCHES = 60;
export const poke = (env: Env, keyId: string, extra: Record<string, unknown> = {}) =>
  env.WATCHER.get(env.WATCHER.idFromName(keyId)).fetch('https://watcher/poke', {method: 'POST', body: JSON.stringify({keyId, ...extra})}).catch(e => console.error('poke', (e as Error).message));
const dev = (c: Ctx) => c.env.DEV_TOOLS === '1';
const tail = (s: string) => { const t = s.replace(/\s+/g, ''); return t.length >= 12 ? t.slice(-4) : ''; };
const ownKey = async (c: Ctx, id: string) => (await c.env.DB.prepare('SELECT * FROM keys WHERE id = ? AND user_id = ?').bind(id, c.user.id).first<any>()) || bad('not_found', 404);
const ownWatch = async (c: Ctx, id: string) => (await c.env.DB.prepare('SELECT * FROM watches WHERE id = ? AND user_id = ?').bind(id, c.user.id).first<any>()) || bad('not_found', 404);
const adapter = (c: Ctx, provider: string) => { const A = ADAPTERS[provider]; if (!A || (provider === 'fake' && !dev(c)) || !providerOf(provider, dev(c))) bad('provider'); return A; };
const ctxOf = (secret: string, meta: Record<string, any>) => Object.assign({secret, meta, fetch: (...a: Parameters<typeof fetch>) => fetch(...a), now: Date.now()}, {memo: new Map()});
/* a provider failure, said in the person's terms */
function providerFail(e: unknown): never {
  if (e instanceof ProviderError) bad(e.kind === 'auth' ? 'key_rejected' : e.kind === 'rate' ? 'provider_busy' : e.kind === 'invalid' || e.kind === 'quota' ? 'provider_refused' : 'provider_down', e.kind === 'auth' ? 400 : 502, {detail: e.message});
  throw e;
}
const keyRow = (k: any) => ({id: k.id, provider: k.provider, label: k.label, comment: k.comment, tail: k.key_tail, status: k.status, error: k.last_error, errorAt: k.error_at, createdAt: k.created_at, checkedAt: k.checked_at, account: JSON.parse(k.meta || '{}').account || '', watches: k.watches ?? 0, active: k.active ?? 0});
const watchRow = (w: any) => ({id: w.id, keyId: w.key_id, keyLabel: w.key_label, provider: w.provider, name: w.name, mode: w.mode, state: w.state, stopReason: w.stop_reason, spec: JSON.parse(w.spec),
  every: w.every_sec, maxLaunch: w.max_launch, launched: w.launched, renotify: w.renotify_min, maxPrice: w.max_price, startsAt: w.starts_at, endsAt: w.ends_at, createdAt: w.created_at, updatedAt: w.updated_at,
  checks: w.checks, lastCheck: w.last_check_at, lastOk: w.last_ok_at, lastSeen: w.last_seen_at, lastNotified: w.last_notified_at, error: w.last_error, status: JSON.parse(w.status || '{}')});

/* the credential as the provider wants it: one line for a key or token, a JSON document for Nebius */
function readSecret(provider: string, raw: unknown): string {
  const s = String(raw ?? '').trim();
  if (!s || s.length > 12000) bad('key_format');
  if (provider === 'nebius') { try { JSON.parse(s); } catch { bad('key_format'); } return s; }
  if (/\s/.test(s)) bad('key_format');
  return s;
}
async function validate(c: Ctx, provider: string, secret: string): Promise<{meta: Record<string, any>; account: string}> {
  if (dev(c) && provider !== 'fake') return {meta: {}, account: ''};   // local runs never reach real providers
  try { const r = await adapter(c, provider).validate(ctxOf(secret, {})); return {meta: {...r.meta, account: r.account || r.meta.account || ''}, account: r.account || ''}; }
  catch (e) { return providerFail(e); }
}

async function runPreflight(c: Ctx, k: any, A: any, w: {spec: Record<string, any>; max_launch: number}) {
  if (dev(c) && k.provider !== 'fake') return [{level: 'warn', text: 'Local run: real providers are not asked.'}];
  const secret = await openKey(c.env, new Uint8Array(k.key_enc), k.id, c.user.id);
  try { return await preflight(A, ctxOf(secret, JSON.parse(k.meta || '{}')) as any, w); }
  catch (e) { return providerFail(e); }
}

/* a watch as the person describes it, checked field by field; the error names the field */
function cleanWatch(c: Ctx, b: any, provider: string, old?: any) {
  const P = providerOf(provider, dev(c)), lim = (LIMITS as any)[provider] || {min: 5, def: 30};
  const s = b.spec || {}, configs = Array.isArray(s.configs) ? s.configs.map((x: unknown) => clean(x, 200)).filter(Boolean) : [];
  if (!configs.length || configs.length > 20 || new Set(configs).size !== configs.length) bad('configs');
  const regions = Array.isArray(s.regions) ? s.regions.map((x: unknown) => clean(x, 100)).filter(Boolean) : [];
  if (regions.length > 60) bad('regions');
  const mode = b.mode === 'launch' ? 'launch' : b.mode === 'notify' ? 'notify' : bad('mode');
  if (P.signal === 'none' && mode === 'notify') bad('notify_unsupported');
  if (P.signal === 'none' && !regions.length) bad('regions');
  const minLevel = ['low', 'medium', 'high'].includes(s.minLevel) ? s.minLevel : 'low';
  const params: Record<string, unknown> = {};
  for (const f of ((PARAMS as any)[provider] || [])) { const v = s.params && s.params[f.id]; if (f.choices) { const x = String(v ?? f.def); if (!f.choices.some((ch: any) => String(ch[0]) === x)) bad('params'); params[f.id] = typeof f.def === 'number' ? Number(x) : x; } }
  let launch: Record<string, unknown> = {};
  if (mode === 'launch') { try { launch = cleanLaunch(provider, s.launch, dev(c)); } catch (e) { bad('launch_field', 400, {field: (e as any).field}); } }
  const names: Record<string, string> = {}, prices: Record<string, number> = {};
  for (const id of configs) { if (s.names && s.names[id]) names[id] = clean(s.names[id], 120); const p = s.prices && Number(s.prices[id]); if (p && p > 0 && p < 1e6) prices[id] = p; }
  const every = Math.round(Number(b.every ?? lim.def)); if (!(every >= lim.min && every <= EVERY_MAX)) bad('every', 400, {min: lim.min});
  const maxLaunch = Math.round(Number(b.maxLaunch ?? 1)); if (!(maxLaunch >= 1 && maxLaunch <= 10)) bad('max_launch');
  const renotify = Math.round(Number(b.renotify ?? 30)); if (!(renotify >= 1 && renotify <= 1440)) bad('renotify');
  const maxPrice = b.maxPrice === '' || b.maxPrice == null ? null : Number(b.maxPrice); if (maxPrice != null && !(maxPrice > 0 && maxPrice < 1e6)) bad('max_price');
  const startsAt = b.startsAt ? Number(b.startsAt) : null, endsAt = b.endsAt ? Number(b.endsAt) : null;
  if ((startsAt != null && !(startsAt > 1.6e12 && startsAt < 4e12)) || (endsAt != null && !(endsAt > 1.6e12 && endsAt < 4e12))) bad('dates');
  if (endsAt != null && (endsAt <= Date.now() || (startsAt && endsAt <= startsAt))) bad('dates');
  const name = clean(b.name, 80) || clean(old && old.name, 80) || bad('name');
  // watches with the same group share one limit: across keys and providers, the group starts at most this many machines in total
  const group = mode === 'launch' ? clean(s.group, 40).toLowerCase() : '';
  if (group && !/^[a-z0-9][a-z0-9 ._-]*$/.test(group)) bad('group');
  return {name, mode, every, maxLaunch, renotify, maxPrice, startsAt, endsAt,
    spec: {configs, regions, minLevel, params, launch, names, prices, currency: clean(s.currency, 3) || 'USD', boundRegion: clean(s.boundRegion, 100) || undefined, group: group || undefined,
      guard: mode === 'launch' && s.guard === false ? false : undefined}};
}

export const appRoutes: Route[] = [
  ['GET', /^\/api\/me$/, async c => {
    const n = await c.env.DB.prepare("SELECT (SELECT COUNT(*) FROM keys WHERE user_id = ?) AS keys, (SELECT COUNT(*) FROM watches WHERE user_id = ? AND state = 'on') AS on_, (SELECT COUNT(*) FROM launches WHERE user_id = ? AND state IN ('created', 'unknown')) AS machines").bind(c.user.id, c.user.id, c.user.id).first<any>();
    return json({email: c.user.email, role: c.user.role, mail: !!c.user.alert_mail, notifyEmail: c.user.notify_email || c.user.email, ownNotify: !!c.user.notify_email, mailReady: mailReady(c.env), dev: dev(c),
      counts: {keys: n.keys, active: n.on_, machines: n.machines}, now: Date.now()});
  }],

  /* ---------- keys ---------- */
  ['GET', /^\/api\/keys$/, async c => json({items: (await c.env.DB.prepare("SELECT k.*, (SELECT COUNT(*) FROM watches w WHERE w.key_id = k.id) AS watches, (SELECT COUNT(*) FROM watches w WHERE w.key_id = k.id AND w.state = 'on') AS active FROM keys k WHERE k.user_id = ? ORDER BY k.created_at").bind(c.user.id).all()).results.map(keyRow)})],
  ['POST', /^\/api\/keys$/, async c => {
    const b = c.body, provider = String(b.provider || ''); adapter(c, provider);
    await limited(c.env, 'key:' + c.user.id);
    const secret = readSecret(provider, b.key), label = clean(b.label, 60) || providerOf(provider, dev(c)).name, comment = clean(b.comment, 500);
    const {meta} = await validate(c, provider, secret), id = newId('key'), now = Date.now();
    const r = await c.env.DB.prepare('INSERT INTO keys (id, user_id, provider, label, comment, key_enc, key_tail, meta, created_at, checked_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM keys WHERE user_id = ?) < ?')
      .bind(id, c.user.id, provider, label, comment, await sealKey(c.env, secret, id, c.user.id), provider === 'nebius' ? '' : tail(secret), JSON.stringify(meta), now, now, c.user.id, MAX_KEYS).run();
    if (!r.meta.changes) bad('key_limit', 409);
    await audit(c.env, c.user.id, 'key_add', provider).run();
    return json({id, account: meta.account || ''}, 201);
  }],
  ['PATCH', /^\/api\/keys\/([\w-]+)$/, async c => {
    const k = await ownKey(c, c.params[0]), b = c.body, set: string[] = [], val: unknown[] = [];
    if (b.label !== undefined) { const l = clean(b.label, 60); if (!l) bad('label'); set.push('label = ?'); val.push(l); }
    if (b.comment !== undefined) { set.push('comment = ?'); val.push(clean(b.comment, 500)); }
    if (b.key !== undefined) {
      await limited(c.env, 'key:' + c.user.id);
      const secret = readSecret(k.provider, b.key), {meta} = await validate(c, k.provider, secret);
      set.push("key_enc = ?, key_tail = ?, meta = ?, status = 'ok', last_error = NULL, error_at = NULL, checked_at = ?"); val.push(await sealKey(c.env, secret, k.id, c.user.id), k.provider === 'nebius' ? '' : tail(secret), JSON.stringify(meta), Date.now());
    }
    if (!set.length) bad('empty');
    await c.env.DB.prepare(`UPDATE keys SET ${set.join(', ')} WHERE id = ? AND user_id = ?`).bind(...val, k.id, c.user.id).run();
    if (b.key !== undefined) { await audit(c.env, c.user.id, 'key_replace', k.provider).run(); c.exec.waitUntil(poke(c.env, k.id)); }
    return json({ok: true});
  }],
  ['POST', /^\/api\/keys\/([\w-]+)\/check$/, async c => {
    const k = await ownKey(c, c.params[0]);
    await limited(c.env, 'key:' + c.user.id);
    const secret = await openKey(c.env, new Uint8Array(k.key_enc), k.id, c.user.id);
    try {
      const {meta} = await validate(c, k.provider, secret);
      await c.env.DB.prepare("UPDATE keys SET status = 'ok', last_error = NULL, error_at = NULL, meta = ?, checked_at = ? WHERE id = ?").bind(JSON.stringify({...JSON.parse(k.meta || '{}'), ...meta}), Date.now(), k.id).run();
      return json({ok: true, account: meta.account || ''});
    } catch (e) {
      if ((e as any).code === 'key_rejected') await c.env.DB.prepare("UPDATE keys SET status = 'error', last_error = ?, error_at = ? WHERE id = ?").bind(String((e as any).extra?.detail || 'Refused'), Date.now(), k.id).run();
      throw e;
    }
  }],
  ['DELETE', /^\/api\/keys\/([\w-]+)$/, async c => {
    const k = await ownKey(c, c.params[0]);
    await c.env.DB.batch([c.env.DB.prepare('DELETE FROM keys WHERE id = ? AND user_id = ?').bind(k.id, c.user.id), audit(c.env, c.user.id, 'key_delete', k.provider)]);
    c.exec.waitUntil(poke(c.env, k.id));
    return json({ok: true});
  }],
  /* everything the watch form needs, read live with the key */
  ['GET', /^\/api\/keys\/([\w-]+)\/catalog$/, async c => {
    const k = await ownKey(c, c.params[0]), A = adapter(c, k.provider);
    await limited(c.env, 'cat:' + c.user.id);
    const params: Record<string, string> = {};
    for (const [kk, v] of c.url.searchParams) if (/^[a-z]{1,20}$/.test(kk)) params[kk] = v.slice(0, 60);
    const secret = await openKey(c.env, new Uint8Array(k.key_enc), k.id, c.user.id), cx: any = ctxOf(secret, JSON.parse(k.meta || '{}'));
    cx.params = params;
    try { return json(await A.catalog(cx)); } catch (e) {
      if (e instanceof ProviderError && e.kind === 'auth') await c.env.DB.prepare("UPDATE keys SET status = 'error', last_error = ?, error_at = ? WHERE id = ?").bind(e.message, Date.now(), k.id).run();
      return providerFail(e);
    }
  }],

  /* reads only: would a launch with these settings go through? Used by the watch form before saving. */
  ['POST', /^\/api\/keys\/([\w-]+)\/preflight$/, async c => {
    const k = await ownKey(c, c.params[0]), A = adapter(c, k.provider), b = c.body || {};
    await limited(c.env, 'pre:' + c.user.id);
    const w = cleanWatch(c, {...b, name: b.name || 'Launch check', mode: 'launch'}, k.provider);
    return json({checks: await runPreflight(c, k, A, {spec: w.spec, max_launch: w.maxLaunch}), at: Date.now()});
  }],

  /* ---------- watches ---------- */
  ['GET', /^\/api\/watches$/, async c => json({items: (await c.env.DB.prepare('SELECT w.*, k.label AS key_label FROM watches w JOIN keys k ON k.id = w.key_id WHERE w.user_id = ? ORDER BY w.state = \'on\' DESC, w.created_at DESC').bind(c.user.id).all()).results.map(watchRow)})],
  ['GET', /^\/api\/watches\/([\w-]+)$/, async c => {
    const w = await c.env.DB.prepare('SELECT w.*, k.label AS key_label FROM watches w JOIN keys k ON k.id = w.key_id WHERE w.id = ? AND w.user_id = ?').bind(c.params[0], c.user.id).first<any>() || bad('not_found', 404);
    const since = Date.now() - 7 * 86400e3;
    const [ev, win, ml] = await c.env.DB.batch([
      c.env.DB.prepare('SELECT id, at, kind, sev, title, detail FROM events WHERE watch_id = ? AND user_id = ? ORDER BY at DESC, id DESC LIMIT 150').bind(w.id, c.user.id),
      c.env.DB.prepare('SELECT target, region, level, start_at, end_at FROM windows WHERE watch_id = ? AND user_id = ? AND (end_at IS NULL OR end_at > ?) ORDER BY start_at').bind(w.id, c.user.id, since),
      c.env.DB.prepare('SELECT * FROM launches WHERE watch_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 20').bind(w.id, c.user.id)
    ]);
    return json({watch: watchRow(w), events: ev.results, windows: win.results, launches: (ml.results as any[]).map(launchRow)});
  }],
  ['POST', /^\/api\/watches$/, async c => {
    const b = c.body, k = await ownKey(c, String(b.keyId || ''));
    if (k.status === 'error') bad('key_broken', 409);
    const v = cleanWatch(c, b, k.provider), id = newId('wch'), now = Date.now(), state = b.paused ? 'paused' : 'on';
    const r = await c.env.DB.prepare(`INSERT INTO watches (id, user_id, key_id, provider, name, mode, state, spec, every_sec, max_launch, renotify_min, max_price, starts_at, ends_at, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM watches WHERE user_id = ?) < ?`)
      .bind(id, c.user.id, k.id, k.provider, v.name, v.mode, state, JSON.stringify(v.spec), v.every, v.maxLaunch, v.renotify, v.maxPrice, v.startsAt, v.endsAt, now, now, c.user.id, MAX_WATCHES).run();
    if (!r.meta.changes) bad('watch_limit', 409);
    await c.env.DB.batch([c.env.DB.prepare("INSERT INTO events (user_id, watch_id, key_id, at, kind, sev, title, detail) VALUES (?, ?, ?, ?, 'state', 'info', ?, '')").bind(c.user.id, id, k.id, now, state === 'on' ? 'Watch created and started' : 'Watch created, paused'), audit(c.env, c.user.id, 'watch_add', k.provider + ' ' + v.mode)]);
    c.exec.waitUntil(poke(c.env, k.id));
    return json({id}, 201);
  }],
  ['PATCH', /^\/api\/watches\/([\w-]+)$/, async c => {
    const w = await ownWatch(c, c.params[0]), b = c.body, now = Date.now();
    if (b.state !== undefined) {
      if (b.state !== 'on' && b.state !== 'paused') bad('state');
      if (b.state === 'on') {
        const k = await ownKey(c, w.key_id); if (k.status === 'error') bad('key_broken', 409);
        if (w.mode === 'launch') {
          const n = await c.env.DB.prepare("SELECT COUNT(*) AS n, SUM(state = 'unknown') AS u FROM launches WHERE watch_id = ? AND state IN ('pending', 'created', 'unknown')").bind(w.id).first<any>();
          if (n.u) bad('launch_unknown', 409);
          if (n.n >= w.max_launch) bad('launch_done', 409);
        }
        if (w.ends_at && w.ends_at <= now) bad('dates');
      }
      await c.env.DB.batch([c.env.DB.prepare("UPDATE watches SET state = ?, stop_reason = '', updated_at = ? WHERE id = ?").bind(b.state, now, w.id),
        c.env.DB.prepare("INSERT INTO events (user_id, watch_id, key_id, at, kind, sev, title, detail) VALUES (?, ?, ?, ?, 'state', 'info', ?, '')").bind(c.user.id, w.id, w.key_id, now, b.state === 'on' ? 'Watch resumed' : 'Watch paused')]);
    } else {
      const v = cleanWatch(c, {...b, name: b.name ?? w.name}, w.provider, w);
      await c.env.DB.batch([c.env.DB.prepare('UPDATE watches SET name = ?, mode = ?, spec = ?, every_sec = ?, max_launch = ?, renotify_min = ?, max_price = ?, starts_at = ?, ends_at = ?, updated_at = ? WHERE id = ?')
        .bind(v.name, v.mode, JSON.stringify(v.spec), v.every, v.maxLaunch, v.renotify, v.maxPrice, v.startsAt, v.endsAt, now, w.id),
        c.env.DB.prepare("INSERT INTO events (user_id, watch_id, key_id, at, kind, sev, title, detail) VALUES (?, ?, ?, ?, 'state', 'info', 'Settings changed', '')").bind(c.user.id, w.id, w.key_id, now)]);
    }
    c.exec.waitUntil(poke(c.env, w.key_id));
    return json({ok: true});
  }],
  ['DELETE', /^\/api\/watches\/([\w-]+)$/, async c => {
    const w = await ownWatch(c, c.params[0]);
    await c.env.DB.batch([c.env.DB.prepare('DELETE FROM watches WHERE id = ? AND user_id = ?').bind(w.id, c.user.id), c.env.DB.prepare('DELETE FROM events WHERE watch_id = ? AND user_id = ?').bind(w.id, c.user.id)]);
    c.exec.waitUntil(poke(c.env, w.key_id));
    return json({ok: true});
  }],
  ['POST', /^\/api\/watches\/([\w-]+)\/preflight$/, async c => {
    const w = await ownWatch(c, c.params[0]), k = await ownKey(c, w.key_id), A = adapter(c, k.provider);
    await limited(c.env, 'pre:' + c.user.id);
    const checks = await runPreflight(c, k, A, {spec: JSON.parse(w.spec), max_launch: w.max_launch});
    const st = JSON.parse(w.status || '{}'); st.pre = {at: Date.now(), checks};
    await c.env.DB.prepare('UPDATE watches SET status = ? WHERE id = ?').bind(JSON.stringify(st), w.id).run();
    return json({checks, at: Date.now()});
  }],
  ['POST', /^\/api\/watches\/([\w-]+)\/check$/, async c => {
    const w = await ownWatch(c, c.params[0]); if (w.state !== 'on') bad('not_running', 409);
    await poke(c.env, w.key_id, {now: true, watchId: w.id});
    return json({ok: true});
  }],
  /* what the engine knows this second: when the next check is, what the last one found */
  ['GET', /^\/api\/live$/, async c => {
    const keys = (await c.env.DB.prepare("SELECT DISTINCT key_id FROM watches WHERE user_id = ? AND state = 'on'").bind(c.user.id).all<{key_id: string}>()).results;
    const out: Record<string, unknown> = {};
    await Promise.all(keys.map(async k => {
      try { const r: any = await (await c.env.WATCHER.get(c.env.WATCHER.idFromName(k.key_id)).fetch('https://watcher/live')).json(); Object.assign(out, r.watches || {}); } catch { /* the list still works from the database */ }
    }));
    const mine = new Set((await c.env.DB.prepare('SELECT id FROM watches WHERE user_id = ?').bind(c.user.id).all<{id: string}>()).results.map(r => r.id));
    for (const id of Object.keys(out)) if (!mine.has(id)) delete out[id];
    return json({watches: out, at: Date.now()});
  }],

  /* ---------- what happened ---------- */
  ['GET', /^\/api\/events$/, async c => {
    const q = c.url.searchParams, before = Number(q.get('before')) || 9e15, kind = q.get('kind');
    const filt = kind === 'seen' ? "AND e.kind IN ('seen', 'gone')" : kind === 'launch' ? "AND e.kind IN ('launch', 'launch_failed')" : kind === 'problem' ? "AND e.sev IN ('warn', 'crit')" : '';
    const r = await c.env.DB.prepare(`SELECT e.id, e.watch_id, e.at, e.kind, e.sev, e.title, e.detail, w.name AS watch_name FROM events e LEFT JOIN watches w ON w.id = e.watch_id WHERE e.user_id = ? AND e.at < ? ${filt} ORDER BY e.at DESC, e.id DESC LIMIT 100`).bind(c.user.id, before).all();
    return json({items: r.results});
  }],
  ['GET', /^\/api\/launches$/, async c => json({items: ((await c.env.DB.prepare('SELECT l.*, w.name AS watch_name, k.label AS key_label FROM launches l LEFT JOIN watches w ON w.id = l.watch_id LEFT JOIN keys k ON k.id = l.key_id WHERE l.user_id = ? ORDER BY l.created_at DESC LIMIT 200').bind(c.user.id).all()).results as any[]).map(launchRow)})],
  ['POST', /^\/api\/launches\/([\w-]+)\/refresh$/, async c => {
    const l = await c.env.DB.prepare('SELECT * FROM launches WHERE id = ? AND user_id = ?').bind(c.params[0], c.user.id).first<any>() || bad('not_found', 404);
    if (!l.ext_id || !l.key_id) bad('no_machine', 409);
    const k = await ownKey(c, l.key_id), A = adapter(c, k.provider);
    if (!A.instance) bad('no_machine', 409);
    await limited(c.env, 'cat:' + c.user.id);
    let d: Record<string, unknown> | null = null;
    try { d = await A.instance!(ctxOf(await openKey(c.env, new Uint8Array(k.key_enc), k.id, c.user.id), JSON.parse(k.meta || '{}')), l.ext_id, l.region); }
    catch (e) { if (!(e instanceof ProviderError && e.status === 404)) providerFail(e); d = null; }   // 404: the provider no longer knows the machine
    const detail = {...JSON.parse(l.detail || '{}'), ...(d || {gone: true}), readAt: Date.now()};
    // the provider says the machine is gone: it no longer counts against any limit
    const ended = !d || /^(terminated|terminating|preempted|deleted|deleting)$/i.test(String(d.status || ''));
    const state = ended && (l.state === 'created' || l.state === 'unknown') ? 'ended' : l.state;
    await c.env.DB.batch([c.env.DB.prepare('UPDATE launches SET detail = ?, state = ?, updated_at = ? WHERE id = ?').bind(JSON.stringify(detail), state, Date.now(), l.id),
      c.env.DB.prepare("UPDATE watches SET launched = (SELECT COUNT(*) FROM launches WHERE watch_id = ? AND state IN ('created', 'unknown')) WHERE id = ?").bind(l.watch_id, l.watch_id)]);
    return json(launchRow({...l, state, detail: JSON.stringify(detail)}));
  }],
  ['DELETE', /^\/api\/launches\/([\w-]+)$/, async c => {
    const l = await c.env.DB.prepare("SELECT watch_id, state FROM launches WHERE id = ? AND user_id = ? AND state IN ('failed', 'unknown', 'created', 'ended')").bind(c.params[0], c.user.id).first<any>() || bad('not_found', 404);
    // a started machine counts until the provider confirms it is gone ("Read status" marks it ended); only then can it leave the list
    if (l.state === 'created') bad('still_running', 409);
    // removing an unconfirmed launch frees its place in the limits: that is the way to resume after you checked the console
    await c.env.DB.batch([c.env.DB.prepare('DELETE FROM launches WHERE id = ? AND user_id = ?').bind(c.params[0], c.user.id),
      c.env.DB.prepare("UPDATE watches SET launched = (SELECT COUNT(*) FROM launches WHERE watch_id = ? AND state IN ('created', 'unknown')) WHERE id = ? AND user_id = ?").bind(l.watch_id, l.watch_id, c.user.id),
      audit(c.env, c.user.id, 'launch_forget', c.params[0])]);
    return json({ok: true});
  }],

  /* ---------- notifications ---------- */
  ['GET', /^\/api\/notices$/, async c => json({items: (await c.env.DB.prepare('SELECT n.id, n.at, n.kind, n.subject, n.result, n.watch_id, w.name AS watch_name FROM notices n LEFT JOIN watches w ON w.id = n.watch_id WHERE n.user_id = ? ORDER BY n.at DESC LIMIT 50').bind(c.user.id).all()).results})],
  ['POST', /^\/api\/notify\/test$/, async c => {
    if (!mailReady(c.env)) bad('mail_off', 409);
    const n = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM notices WHERE user_id = ? AND kind = 'test' AND at > ?").bind(c.user.id, Date.now() - 3600e3).first<number>('n');
    if ((n || 0) >= 5) bad('slow_down', 429);
    const r = await tell(c.env, c.user.id, null, 'test', 'API Check: test message', 'This is a test from API Check. If you can read it, messages about your watches will reach you here: capacity seen, a machine started, a watch that stopped.', true);
    if (r !== 'sent') bad('send_failed', 502, {detail: r});
    return json({ok: true});
  }]
];
function launchRow(l: any) {
  return {id: l.id, watchId: l.watch_id, watchName: l.watch_name, keyId: l.key_id, keyLabel: l.key_label, provider: l.provider, target: l.target, region: l.region, name: l.name, extId: l.ext_id, state: l.state,
    price: l.price, currency: l.currency, detail: JSON.parse(l.detail || '{}'), error: l.error, createdAt: l.created_at, updatedAt: l.updated_at};
}
export {mailOk};
