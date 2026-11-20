// The engine. One Durable Object per provider key runs every watch on that key from a single alarm loop:
//  - one availability request per check serves all the key's watches, so the provider's rate limit is shared, not multiplied;
//  - launches on one key happen one at a time, so two watches can never start two machines in the same instant;
//  - the loop can run every few seconds (Cloudflare cron cannot go below a minute).
// The database is the record; memory here is a cache that can be lost at any moment and rebuilt from the database.
import {DurableObject} from 'cloudflare:workers';
import {openKey, newId} from './crypto';
import {PROVIDERS} from './providers';
import {tell, appLink} from './notify';
import {ProviderError} from './types';
import type {Env, Offer, Level, Ctx, Provider, Launched, LaunchPlan} from './types';
import {Unclear} from './providers/net';
import {LIMITS, levelRank} from '../../shared/providers.js';

type Watch = {id: string; user_id: string; key_id: string; provider: string; name: string; mode: string; state: string; spec: any; every_sec: number; max_launch: number; launched: number;
  renotify_min: number; max_price: number | null; starts_at: number | null; ends_at: number | null; checks: number; last_seen_at: number | null; last_notified_at: number | null; updated_at: number};
type Run = {next: number; open: Map<string, {id: number; level: Level}>; found: Offer[]; err: string; errSince: number; fails: number; checks: number; lastAt: number; okAt: number;
  savedAt: number; dirty: boolean; announced: boolean; holdUntil: number; tried: number; missLogged: number; reconAt: number};
type Key = {id: string; user_id: string; provider: string; label: string; key_enc: ArrayBuffer; meta: string; status: string};

const RELOAD_MS = 20e3, SAVE_MS = 15e3, MISS_LOG_MS = 10 * 60e3, BACKOFF_MAX = 5 * 60e3, RECON_MS = 30e3, PENDING_STALE_MS = 150e3;
const SETTLE_MS = [3000, 10000, 20000];
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const sevOf = (k: ProviderError['kind']) => (k === 'capacity' ? 'info' : k === 'rate' || k === 'http' ? 'warn' : 'crit');

export class Watcher extends DurableObject<Env> {
  keyId = '';
  key: Key | null = null;
  secret = '';
  watches: Watch[] = [];
  loadedAt = 0;
  runs = new Map<string, Run>();
  keyNext = 0;           // the earliest the provider may be asked again (backoff, Retry-After)
  launchNext = 0;        // the earliest the next launch request may go (Lambda: one per 12 s)
  catalogPrice = new Map<string, number>();
  busy = false;

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/poke') {
      const b: any = await req.json().catch(() => ({}));
      this.keyId = b.keyId || this.keyId;
      await this.ctx.storage.put('keyId', this.keyId);
      this.loadedAt = 0;
      if (b.now && b.watchId) { const r = this.runs.get(b.watchId); if (r) r.next = 0; else this.runs.delete(b.watchId); }
      await this.ctx.storage.setAlarm(Date.now() + 50);
      return Response.json({ok: true});
    }
    if (url.pathname === '/live') {
      const out: Record<string, unknown> = {};
      for (const [id, r] of this.runs) out[id] = {next: r.next, lastAt: r.lastAt, okAt: r.okAt, checks: r.checks, found: r.found, err: r.err, errSince: r.errSince, holdUntil: r.holdUntil};
      return Response.json({watches: out, keyNext: this.keyNext, at: Date.now()});
    }
    return new Response('not found', {status: 404});
  }

  async alarm() {
    if (this.busy) { await this.ctx.storage.setAlarm(Date.now() + 1000); return; }
    this.busy = true;
    let next: number | null = null;
    try { next = await this.tick(Date.now()); }
    catch (e) { console.error('watcher', this.keyId, (e as Error).message); next = Date.now() + 15e3; }
    finally { this.busy = false; }
    if (next) await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 250));
    else await this.ctx.storage.deleteAlarm();
  }

  async load(now: number) {
    if (!this.keyId) this.keyId = (await this.ctx.storage.get<string>('keyId')) || '';
    if (!this.keyId) return;
    const db = this.env.DB;
    const k = await db.prepare('SELECT k.id, k.user_id, k.provider, k.label, k.key_enc, k.meta, k.status FROM keys k JOIN users u ON u.id = k.user_id WHERE k.id = ? AND u.disabled = 0').bind(this.keyId).first<Key>();
    if (!k) { this.key = null; this.watches = []; return; }
    this.secret = await openKey(this.env, new Uint8Array(k.key_enc), k.id, k.user_id);
    this.key = k;
    const rows = (await db.prepare("SELECT * FROM watches WHERE key_id = ? AND state = 'on'").bind(this.keyId).all<any>()).results;
    this.watches = rows.map(w => ({...w, spec: JSON.parse(w.spec)}));
    const ids = new Set(this.watches.map(w => w.id));
    for (const id of [...this.runs.keys()]) if (!ids.has(id)) this.runs.delete(id);
    // windows left open by a previous life of this object are picked up again, so they are closed properly
    for (const w of this.watches) if (!this.runs.has(w.id)) {
      const open = new Map<string, {id: number; level: Level}>();
      for (const o of (await db.prepare('SELECT id, target, region, level FROM windows WHERE watch_id = ? AND end_at IS NULL').bind(w.id).all<any>()).results) open.set(o.target + '|' + o.region, {id: o.id, level: o.level});
      this.runs.set(w.id, {next: 0, open, found: [], err: '', errSince: 0, fails: 0, checks: w.checks, lastAt: 0, okAt: 0, savedAt: now, dirty: false, announced: open.size > 0, holdUntil: 0, tried: 0, missLogged: 0, reconAt: 0});
    }
    this.loadedAt = now;
  }

  ctxFor(now: number): Ctx { return Object.assign({secret: this.secret, meta: JSON.parse(this.key!.meta || '{}'), fetch: (...a: Parameters<typeof fetch>) => fetch(...a), now}, {memo: new Map()}); }

  /** one turn of the loop; returns when it wants to run again, or null to sleep until poked */
  async tick(now: number): Promise<number | null> {
    if (!this.loadedAt || now - this.loadedAt > RELOAD_MS) await this.load(now);
    if (!this.key || this.key.status === 'error') return null;
    const P = PROVIDERS[this.key.provider];
    if (!P) return null;
    // watches that have run out of time end here
    for (const w of this.watches) if (w.ends_at && now >= w.ends_at) await this.finish(w, 'done', 'The watch reached its end time.', now);
    const live = this.watches.filter(w => w.state === 'on' && (!w.starts_at || w.starts_at <= now));
    if (!live.length) {
      const later = this.watches.filter(w => w.state === 'on' && w.starts_at && w.starts_at > now).map(w => w.starts_at!);
      return later.length ? Math.min(...later) : null;
    }
    if (now < this.keyNext) return this.keyNext;
    const due = live.filter(w => (this.runs.get(w.id)?.next || 0) <= now);
    if (due.length) {
      const c = this.ctxFor(now);
      for (const w of due) {
        const r = this.runs.get(w.id)!;
        try { await this.check(P, c, w, r, now); }
        catch (e) { await this.failed(w, r, e, now); }
        r.checks++; r.lastAt = now; r.dirty = true;
        const lim = LIMITS[this.key.provider] || {min: 5};
        r.next = Math.max(now + Math.max(w.every_sec, lim.min) * 1000 * (0.95 + Math.random() * 0.1), r.holdUntil, this.keyNext);
        if (r.fails) r.next = Math.max(r.next, now + Math.min(BACKOFF_MAX, 5e3 * 2 ** Math.min(r.fails, 6)));
        if (w.state !== 'on') this.runs.delete(w.id);
      }
      await this.save(now, false);
    }
    const nexts = this.watches.filter(w => w.state === 'on').map(w => this.runs.get(w.id)?.next || now + 1000);
    return nexts.length ? Math.min(...nexts) : null;
  }

  /** what this watch is looking for, in order of preference */
  async check(P: Provider, c: Ctx, w: Watch, r: Run, now: number) {
    const s = w.spec, targets: string[] = s.configs || [], regions: string[] = s.regions || [];
    const min = levelRank(s.minLevel || 'low');
    const offers = await P.offers(c, w);
    r.okAt = now;
    if (r.err) { await this.event(w, 'recovered', 'ok', 'Back in touch with the provider', r.err, now); r.err = ''; r.errSince = 0; r.fails = 0; }
    let found: Offer[] = [];
    if (offers) {
      found = offers.filter(o => targets.includes(o.config) && (!regions.length || regions.includes(o.region)) && levelRank(o.level) >= min && levelRank(o.level) > 0);
      if (w.max_price != null) found = found.filter(o => { const p = this.price(w, o.config); return p == null || p <= w.max_price!; });
      found.sort((a, b) => targets.indexOf(a.config) - targets.indexOf(b.config) || (regions.length ? regions.indexOf(a.region) - regions.indexOf(b.region) : levelRank(b.level) - levelRank(a.level)));
      await this.windows(w, r, found, now);
    }
    r.found = found;
    if (found.length) { w.last_seen_at = now; }
    if (w.mode === 'notify') {
      if (found.length && !r.announced) {
        r.announced = true;
        if (!w.last_notified_at || now - w.last_notified_at >= w.renotify_min * 60e3) await this.announce(w, found, now);
      }
      if (!found.length) r.announced = false;
      return;
    }
    // launch mode: settle anything left unclear first, then a provider without an availability signal is probed by the launch itself
    await this.reconcile(P, c, w, r, now);
    if (w.state !== 'on') return;
    if (w.launched >= w.max_launch) { await this.finish(w, 'done', await this.whyFull(w), now); return; }
    const tries: Offer[] = offers ? found : this.probes(w);
    if (!tries.length || now < r.holdUntil) return;
    if (now < this.launchNext) { r.holdUntil = this.launchNext; return; }
    await this.launch(P, c, w, r, tries, now);
  }

  /** with no availability signal (UpCloud), every configuration and region the watch names is a candidate, tried in turn */
  probes(w: Watch): Offer[] {
    const s = w.spec, out: Offer[] = [], regs: string[] = s.regions && s.regions.length ? s.regions : (s.probeRegions || []);
    for (const t of s.configs || []) for (const g of regs) out.push({config: t, region: g, level: 'yes'});
    return out;
  }
  nm(w: Watch, config: string): string { return (w.spec.names && w.spec.names[config]) || config; }
  price(w: Watch, config: string): number | null {
    const p = w.spec.prices && w.spec.prices[config];
    return typeof p === 'number' ? p : null;
  }

  /* Launch safety. A machine costs money, so the rules are strict:
   *  1. A launch row is claimed in the database before the provider is asked. The claim is one conditional INSERT, so it is atomic
   *     even across Durable Objects: it fails if the watch is no longer on, if the watch already has as many machines as allowed, or if
   *     its group (watches hunting for the same machine on different keys or providers) does. Rows that are pending, created or unknown all count.
   *  2. Every attempt names its machine uniquely (the name ends in part of the launch id). When an answer is unclear (timeout, network
   *     failure, 5xx), the provider is asked by that name whether the machine exists before anything else happens.
   *  3. A launch interrupted by a restart (a deploy, an eviction) leaves a pending row; the next check settles it the same way.
   *  4. Whatever cannot be settled stays "unknown", keeps counting against the limit and stops the watch until a person decides. */
  async launch(P: Provider, c: Ctx, w: Watch, r: Run, tries: Offer[], now: number) {
    const gap = (LIMITS[w.provider] || {}).launchGap || 0;
    // one candidate per check where the provider meters launches; otherwise up to three in a row
    const list = gap ? [tries[r.tried++ % tries.length]] : tries.slice(0, 3);
    for (const o of list) {
      const id = newId('mch'), base = String((w.spec.launch && w.spec.launch.name) || 'apicheck').slice(0, 40);
      const name = base + '-' + id.slice(-6), price = this.price(w, o.config);
      if (!(await this.claim(w, id, o, name, price, now))) { await this.finish(w, 'done', await this.whyFull(w), now); return; }
      if (gap) this.launchNext = Date.now() + gap;
      const plan = {config: o.config, region: o.region, name, spec: {...w.spec, watchId: w.id, launchId: id}};
      let res: Launched | null = null, pe: ProviderError | null = null;
      try { res = await P.launch(c, plan); }
      catch (e) { pe = e instanceof ProviderError ? e : new ProviderError('http', (e as Error).message); }
      // an answer that does not say whether a machine was made is settled by looking for it, never by asking again
      const unsure = !!pe && (pe instanceof Unclear || (pe.kind === 'http' && (pe.status === 0 || pe.status >= 500)));
      if (unsure && P.find) {
        const f = await this.settle(P, c, plan);
        if (f) { res = {extId: f.extId, name, detail: {status: f.status, settled: 'found by name after an unclear answer: ' + pe!.message}}; pe = null; }
      }
      if (res) { if (await this.started(P, w, o, id, name, price, res, now)) return; continue; }
      if (unsure && (pe instanceof Unclear || !P.find)) {
        await this.env.DB.prepare("UPDATE launches SET state = 'unknown', ext_id = ?, error = ?, updated_at = ? WHERE id = ?").bind((pe as any).extId || null, pe!.message, Date.now(), id).run();
        await this.event(w, 'launch_failed', 'crit', 'The provider did not confirm a launch', `${pe!.message} Machine name: ${name}.${P.find ? ' No machine with this name had appeared after half a minute.' : ''} The watch is stopped so a second machine is not started by mistake. Check the provider console: if there is no such machine, delete this launch on the Machines page and resume the watch.`, now);
        await this.finish(w, 'stopped', `A launch was not confirmed by the provider (machine name ${name}). Check the console, then delete the launch on the Machines page if nothing was started, and resume.`, now, true);
        return;
      }
      if (unsure) {
        // a definite error answer, and the provider was asked by name: no machine exists, so this was a refusal
        await this.env.DB.prepare("UPDATE launches SET state = 'failed', error = ?, updated_at = ? WHERE id = ?").bind(pe!.message + ' (checked by name: no machine was made)', Date.now(), id).run();
        r.holdUntil = Date.now() + Math.max(15e3, pe!.retryAfter * 1000); this.keyNext = Math.max(this.keyNext, r.holdUntil);
        await this.event(w, 'launch_failed', 'warn', 'Launch failed at the provider, will retry', pe!.message + ' No machine with the name ' + name + ' exists there.', now);
        return;
      }
      pe = pe!;
      if (pe.kind === 'capacity') {
        await this.env.DB.prepare('DELETE FROM launches WHERE id = ?').bind(id).run();
        if (now - r.missLogged > MISS_LOG_MS) { r.missLogged = now; await this.event(w, 'notice', 'info', 'Seen, but taken before the launch went through', `${this.nm(w, o.config)} in ${o.region}: ${pe.message}`, now); }
        continue;
      }
      await this.env.DB.prepare("UPDATE launches SET state = 'failed', error = ?, updated_at = ? WHERE id = ?").bind(pe.message, Date.now(), id).run();
      if (pe.kind === 'rate' || pe.kind === 'http') { r.holdUntil = Date.now() + Math.max(15e3, pe.retryAfter * 1000); this.keyNext = Math.max(this.keyNext, r.holdUntil); await this.event(w, 'launch_failed', 'warn', 'Launch refused for now, will retry', pe.message, now); return; }
      // auth, quota, invalid, money: repeating would only repeat the refusal
      await this.event(w, 'launch_failed', 'crit', 'Launch refused: ' + ({auth: 'the key was refused', quota: 'account limit', invalid: 'the request was rejected', money: 'not enough balance', http: 'the provider failed'} as any)[pe.kind], pe.message, now);
      await this.finish(w, 'stopped', 'The provider refused the launch: ' + pe.message, now, true);
      return;
    }
  }

  /** the atomic claim; true when this launch may go ahead */
  async claim(w: Watch, id: string, o: Offer, name: string, price: number | null, now: number): Promise<boolean> {
    const g = this.group(w), cap = Math.max(1, w.max_launch);
    const r = await this.env.DB.prepare(`INSERT INTO launches (id, user_id, watch_id, key_id, provider, target, region, name, state, price, currency, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM watches WHERE id = ? AND state = 'on' AND mode = 'launch')
        AND (SELECT COUNT(*) FROM launches WHERE watch_id = ? AND state IN ('pending', 'created', 'unknown')) < ?
        AND (? = '' OR (SELECT COUNT(*) FROM launches l JOIN watches x ON x.id = l.watch_id WHERE x.user_id = ? AND x.mode = 'launch' AND json_extract(x.spec, '$.group') = ? AND l.state IN ('pending', 'created', 'unknown')) < ?)`)
      .bind(id, w.user_id, w.id, w.key_id, w.provider, o.config, o.region, name, price, (w.spec.currency || 'USD'), now, now, w.id, w.id, cap, g, w.user_id, g, cap).run();
    return !!r.meta.changes;
  }
  group(w: Watch): string { return typeof w.spec.group === 'string' ? w.spec.group : ''; }
  async whyFull(w: Watch): Promise<string> {
    const n = await this.env.DB.prepare("SELECT state, COUNT(*) AS n FROM launches WHERE watch_id = ? AND state IN ('pending', 'created', 'unknown') GROUP BY state").bind(w.id).all<any>();
    const by: Record<string, number> = {}; for (const x of n.results) by[x.state] = x.n;
    if (by.unknown) return `A launch is still unconfirmed (${by.unknown}). It counts as a machine until you delete it on the Machines page.`;
    if ((by.created || 0) + (by.pending || 0) >= w.max_launch) return `Started ${by.created || 0} of ${w.max_launch} machine${w.max_launch === 1 ? '' : 's'}.`;
    const g = this.group(w);
    return g ? `The group "${g}" already has its machine${w.max_launch === 1 ? '' : 's'}, started by another watch.` : 'The watch is no longer on.';
  }

  /** ask by name, three times over about half a minute: providers can be slow to list a machine they have just accepted */
  async settle(P: Provider, c: Ctx, plan: LaunchPlan): Promise<{extId: string; status?: string} | null> {
    for (const ms of SETTLE_MS) {
      await sleep(this.env.DEV_TOOLS === '1' ? ms / 100 : ms);
      try { const f = await P.find!(c, plan); if (f) return f; } catch { /* asked again on the next round */ }
    }
    return null;
  }

  /** a machine exists: record it, count it, tell the person, and stop the group's other launch watches */
  async started(P: Provider, w: Watch, o: Offer, id: string, name: string, price: number | null, res: Launched, now: number): Promise<boolean> {
    const db = this.env.DB;
    await db.batch([
      db.prepare("UPDATE launches SET state = 'created', ext_id = ?, price = COALESCE(?, price), currency = COALESCE(?, currency), detail = ?, error = NULL, updated_at = ? WHERE id = ?").bind(res.extId, res.price ?? null, res.currency ?? null, JSON.stringify(res.detail || {}), Date.now(), id),
      db.prepare("UPDATE watches SET launched = (SELECT COUNT(*) FROM launches WHERE watch_id = ? AND state IN ('created', 'unknown')), updated_at = ? WHERE id = ?").bind(w.id, Date.now(), w.id)
    ]);
    w.launched = (await db.prepare("SELECT launched FROM watches WHERE id = ?").bind(w.id).first<number>('launched')) ?? w.launched + 1;
    const what = this.nm(w, o.config) + ' in ' + o.region;
    await this.event(w, 'launch', 'ok', 'Machine started: ' + what, `${P.id} id ${res.extId}, name ${name}`, now);
    await tell(this.env, w.user_id, w.id, 'launch', `API Check: started ${this.nm(w, o.config)} (${w.name})`,
      `The watch "${w.name}" found ${what} free and started it.\n\nProvider id: ${res.extId}\nName: ${name}${price != null ? `\nPrice: ${price} ${w.spec.currency || 'USD'} per hour` : ''}\n\nBilling runs from now until you terminate it in the provider's console.${appLink(this.env, 'machines') ? '\n\nMachines: ' + appLink(this.env, 'machines') : ''}`);
    const g = this.group(w);
    if (g) await this.stopGroup(w, g, now);
    if (w.launched >= w.max_launch) { await this.finish(w, 'done', `Started ${w.launched} of ${w.max_launch} machine${w.max_launch === 1 ? '' : 's'}.`, now, true); return true; }
    return false;
  }

  /** the other launch watches of a group whose machines are all started stop now, on every key; their own claims would refuse anyway */
  async stopGroup(w: Watch, g: string, now: number) {
    const db = this.env.DB;
    const used = await db.prepare("SELECT COUNT(*) AS n FROM launches l JOIN watches x ON x.id = l.watch_id WHERE x.user_id = ? AND x.mode = 'launch' AND json_extract(x.spec, '$.group') = ? AND l.state IN ('pending', 'created', 'unknown')").bind(w.user_id, g).first<number>('n');
    if ((used || 0) < w.max_launch) return;
    const others = (await db.prepare("SELECT id, key_id FROM watches WHERE user_id = ? AND mode = 'launch' AND state = 'on' AND id <> ? AND json_extract(spec, '$.group') = ?").bind(w.user_id, w.id, g).all<any>()).results;
    if (!others.length) return;
    const why = `The group "${g}" has its machine: "${w.name}" started it.`;
    await db.batch(others.flatMap(x => [
      db.prepare("UPDATE watches SET state = 'done', stop_reason = ?, updated_at = ? WHERE id = ? AND state = 'on'").bind(why, now, x.id),
      db.prepare("INSERT INTO events (user_id, watch_id, key_id, at, kind, sev, title, detail) VALUES (?, ?, ?, ?, 'state', 'ok', 'Watch finished', ?)").bind(w.user_id, x.id, x.key_id, now, why)
    ]));
    for (const x of others) if (x.key_id !== this.keyId) await this.env.WATCHER.get(this.env.WATCHER.idFromName(x.key_id)).fetch('https://watcher/poke', {method: 'POST', body: JSON.stringify({keyId: x.key_id})}).catch(() => null);
    for (const x of this.watches) if (others.some(o => o.id === x.id)) x.state = 'done';
  }

  /** launches left pending by an earlier life of this object, and unconfirmed ones, are looked up by name */
  async reconcile(P: Provider, c: Ctx, w: Watch, r: Run, now: number) {
    if (now - r.reconAt < RECON_MS) return;
    r.reconAt = now;
    const db = this.env.DB;
    const rows = (await db.prepare("SELECT id, target, region, name, state FROM launches WHERE watch_id = ? AND ((state = 'pending' AND created_at < ?) OR (state = 'unknown' AND ext_id IS NULL))").bind(w.id, now - PENDING_STALE_MS).all<any>()).results;
    for (const l of rows) {
      const plan = {config: l.target, region: l.region, name: l.name, spec: {...w.spec, watchId: w.id, launchId: l.id}};
      let f: {extId: string; status?: string} | null = null, asked = false;
      if (P.find) { try { f = await P.find(c, plan); asked = true; } catch { /* try again later */ } }
      if (f) {
        await db.batch([db.prepare("UPDATE launches SET state = 'created', ext_id = ?, error = NULL, detail = ?, updated_at = ? WHERE id = ?").bind(f.extId, JSON.stringify({status: f.status, settled: 'found by name later'}), now, l.id),
          db.prepare("UPDATE watches SET launched = (SELECT COUNT(*) FROM launches WHERE watch_id = ? AND state IN ('created', 'unknown')), updated_at = ? WHERE id = ?").bind(w.id, now, w.id)]);
        await this.event(w, 'launch', 'ok', 'Machine found: ' + this.nm(w, l.target) + ' in ' + l.region, `An interrupted or unclear launch did start a machine: ${P.id} id ${f.extId}, name ${l.name}. It is counted.`, now);
        await tell(this.env, w.user_id, w.id, 'launch', `API Check: a machine is running for "${w.name}"`, `A launch that was interrupted or unclear did start a machine.\n\nProvider id: ${f.extId}\nName: ${l.name}\n\nBilling runs until you terminate it in the provider's console.`);
      } else if (l.state === 'pending' && asked) {
        await db.prepare("UPDATE launches SET state = 'failed', error = ?, updated_at = ? WHERE id = ? AND state = 'pending'").bind('Interrupted before the provider answered; no machine with this name exists there.', now, l.id).run();
      } else if (l.state === 'pending') {
        await db.prepare("UPDATE launches SET state = 'unknown', error = ?, updated_at = ? WHERE id = ? AND state = 'pending'").bind('Interrupted before the provider answered. Check the console for a machine named ' + l.name + '.', now, l.id).run();
        await this.finish(w, 'stopped', `A launch was interrupted (machine name ${l.name}). Check the console, then delete the launch on the Machines page if nothing was started, and resume.`, now, true);
      }
    }
    if (rows.length) w.launched = (await db.prepare("SELECT COUNT(*) AS n FROM launches WHERE watch_id = ? AND state IN ('created', 'unknown')").bind(w.id).first<number>('n')) ?? w.launched;
  }

  async failed(w: Watch, r: Run, e: unknown, now: number) {
    const pe = e instanceof ProviderError ? e : new ProviderError('http', (e as Error).message || 'Unknown error');
    r.fails++;
    if (pe.kind === 'rate' && pe.retryAfter) this.keyNext = now + pe.retryAfter * 1000;
    if (pe.kind === 'auth') {
      await this.env.DB.prepare("UPDATE keys SET status = 'error', last_error = ?, error_at = ? WHERE id = ?").bind(pe.message, now, w.key_id).run();
      if (this.key) this.key.status = 'error';
      for (const x of this.watches.filter(x => x.state === 'on')) await this.finish(x, 'stopped', 'The provider refused the key: ' + pe.message, now, x.id === w.id);
      return;
    }
    if (!r.err) { r.err = pe.message; r.errSince = now; await this.event(w, 'error', sevOf(pe.kind), 'Could not check: ' + ({rate: 'rate limited', http: 'provider not answering', quota: 'account limit', invalid: 'request rejected', money: 'balance', capacity: 'no capacity'} as any)[pe.kind], pe.message, now); }
    else r.err = pe.message;
    // a check that keeps failing for 30 minutes is worth an email, once
    if (r.errSince && now - r.errSince > 30 * 60e3 && !(r as any).mailed) { (r as any).mailed = true; await tell(this.env, w.user_id, w.id, 'error', `API Check: "${w.name}" cannot reach the provider`, `For half an hour the watch "${w.name}" has not been able to check. The last answer was:\n\n${pe.message}\n\nIt keeps trying with a growing delay.${appLink(this.env, 'watch/' + w.id) ? '\n\n' + appLink(this.env, 'watch/' + w.id) : ''}`); }
  }

  async windows(w: Watch, r: Run, found: Offer[], now: number) {
    const db = this.env.DB, keys = new Map(found.map(o => [o.config + '|' + o.region, o])), opened: Offer[] = [], closed: string[] = [];
    for (const [k, o] of keys) if (!r.open.has(k)) {
      const row = await db.prepare('INSERT INTO windows (user_id, watch_id, target, region, level, start_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id').bind(w.user_id, w.id, o.config, o.region, o.level, now).first<{id: number}>();
      r.open.set(k, {id: row!.id, level: o.level}); opened.push(o);
    }
    for (const [k, v] of r.open) if (!keys.has(k)) { await db.prepare('UPDATE windows SET end_at = ? WHERE id = ?').bind(now, v.id).run(); r.open.delete(k); closed.push(k); }
    const name = (o: Offer) => this.nm(w, o.config) + ' in ' + o.region;
    if (opened.length) await this.event(w, 'seen', 'ok', 'Available: ' + opened.slice(0, 3).map(name).join(', ') + (opened.length > 3 ? ` and ${opened.length - 3} more` : ''), opened.map(o => `${o.config} ${o.region} (${o.level})`).join(', '), now);
    if (closed.length) await this.event(w, 'gone', 'info', 'Gone: ' + closed.slice(0, 3).map(k => { const [c, g] = k.split('|'); return this.nm(w, c) + ' in ' + g; }).join(', ') + (closed.length > 3 ? ` and ${closed.length - 3} more` : ''), '', now);
  }

  async announce(w: Watch, found: Offer[], now: number) {
    w.last_notified_at = now;
    await this.env.DB.prepare('UPDATE watches SET last_notified_at = ? WHERE id = ?').bind(now, w.id).run();
    const lines = found.slice(0, 12).map(o => `- ${this.nm(w, o.config)} in ${o.region}${o.level !== 'yes' ? ` (${o.level} availability)` : ''}${this.price(w, o.config) != null ? `, ${this.price(w, o.config)} ${w.spec.currency || 'USD'}/h` : ''}`);
    const first = found[0];
    await tell(this.env, w.user_id, w.id, 'seen', `API Check: ${this.nm(w, first.config)} is available in ${first.region}${found.length > 1 ? ` (+${found.length - 1})` : ''}`,
      `The watch "${w.name}" sees free capacity now:\n\n${lines.join('\n')}${found.length > 12 ? `\n- and ${found.length - 12} more` : ''}\n\nCapacity like this can go within seconds. This watch only tells you; it does not start a machine.\nYou will hear again after it is gone and comes back, and not more than once every ${w.renotify_min} minutes.${appLink(this.env, 'watch/' + w.id) ? '\n\n' + appLink(this.env, 'watch/' + w.id) : ''}`);
  }

  async finish(w: Watch, state: 'done' | 'stopped', why: string, now: number, mail = false) {
    if (w.state !== 'on') return;
    w.state = state;
    const r = this.runs.get(w.id);
    if (r) for (const v of r.open.values()) await this.env.DB.prepare('UPDATE windows SET end_at = ? WHERE id = ?').bind(now, v.id).run();
    await this.env.DB.prepare("UPDATE watches SET state = ?, stop_reason = ?, updated_at = ? WHERE id = ? AND state = 'on'").bind(state, why, now, w.id).run();
    await this.event(w, 'state', state === 'done' ? 'ok' : 'crit', state === 'done' ? 'Watch finished' : 'Watch stopped', why, now);
    if (mail && state === 'stopped') await tell(this.env, w.user_id, w.id, 'stopped', `API Check: "${w.name}" stopped`, `The watch "${w.name}" has stopped.\n\n${why}${appLink(this.env, 'watch/' + w.id) ? '\n\n' + appLink(this.env, 'watch/' + w.id) : ''}`);
  }

  event(w: Watch, kind: string, sev: string, title: string, detail: string, at: number) {
    return this.env.DB.prepare('INSERT INTO events (user_id, watch_id, key_id, at, kind, sev, title, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(w.user_id, w.id, w.key_id, at, kind, sev, title.slice(0, 200), String(detail || '').slice(0, 1000)).run();
  }

  /** the list view reads the database; it is brought up to date every few seconds, not on every check */
  async save(now: number, force: boolean) {
    const st: D1PreparedStatement[] = [];
    for (const w of this.watches) {
      const r = this.runs.get(w.id); if (!r || (!force && !r.dirty) || (!force && now - r.savedAt < SAVE_MS && !this.changed(r))) continue;
      st.push(this.env.DB.prepare('UPDATE watches SET checks = ?, last_check_at = ?, last_ok_at = COALESCE(?, last_ok_at), last_seen_at = ?, last_error = ?, status = ? WHERE id = ?')
        .bind(r.checks, r.lastAt || null, r.okAt || null, w.last_seen_at, r.err || null, JSON.stringify({found: r.found.slice(0, 20), err: r.err, errSince: r.errSince, next: r.next}), w.id));
      r.savedAt = now; r.dirty = false; (r as any).sig = this.sig(r);
    }
    if (st.length) await this.env.DB.batch(st);
  }
  sig(r: Run) { return r.found.map(o => o.config + '|' + o.region + '|' + o.level).join(',') + '#' + r.err; }
  changed(r: Run) { return (r as any).sig !== this.sig(r); }
}
