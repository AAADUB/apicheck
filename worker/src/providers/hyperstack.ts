// Hyperstack (NexGen Cloud). API: https://infrahub-api.nexgencloud.com/v1, key in the "api_key" header (no prefix).
// Read 20.11.2026 from docs.hyperstack.cloud and the models of the official SDK (@nexgencloud/hyperstack-sdk-javascript 1.56.9-alpha).
// Availability: GET /core/flavors gives every flavor per region with "stock_available"; GET /core/stocks gives, per region and GPU model,
//   how many machines of 1x, 2x, 4x, 8x and 10x GPUs can be deployed now ("configurations").
// Launch: POST /core/virtual-machines {name, environment_name, flavor_name, image_name, key_name, count: 1, ...}. An environment lives in one
//   region and holds the SSH keys, so the region decides the environment, the key and the image.
// Errors: {status: false, message, error_reason}. 400 bad_request (also "Insufficient balance to create the resource"), 401, 403, 404, 405, 409 already_exist, 429, 500.
//   Running out of capacity is not documented as an error code, so a 400 that is not plainly about the request, the balance or a limit is treated as capacity.
// Limits: 500 requests per minute per source IP, across all endpoints.
import {ProviderError} from '../types';
import type {Provider, Ctx, Catalog, Config, Offer, Option, LaunchPlan, Check, Machine} from '../types';
import {call, round2, prep} from './net';
import type {Classify} from './net';

const BASE = 'https://infrahub-api.nexgencloud.com/v1';
const H = (c: Ctx) => ({api_key: c.secret.trim()});
const classify: Classify = (status, body, text) => {
  const m = String((body && (body.message || body.error_reason)) || text || '');
  if (status === 401) return 'auth';
  if (status === 403) return 'quota';
  if (status === 429) return 'rate';
  if (status === 404 || status === 405 || status === 406 || status === 409) return 'invalid';
  if (status === 400) {
    if (body && body.error_reason === 'compatibility_blocked') return 'invalid';
    if (/balance|credit|payment|fund/i.test(m)) return 'money';
    if (/quota|limit exceeded|maximum/i.test(m)) return 'quota';
    if (/stock|capacity|not enough|insufficient (gpu|resource)|unavailable|no (available )?host|out of/i.test(m)) return 'capacity';
    if (/invalid|must|required|not found|does not exist|format|length|already/i.test(m)) return 'invalid';
    return 'capacity';
  }
  return null;
};
const get = (c: Ctx, path: string, memo = false) => call(c, BASE + path, {headers: H(c), memo}, classify);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/* Hyperstack names: letters, digits and dashes */
const vmName = (n: string) => n.replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'apicheck';
async function soft<T>(notes: string[], what: string, fn: () => Promise<T>, empty: T): Promise<T> {
  try { return await fn(); } catch (e) { notes.push(`Could not read ${what}: ${(e as Error).message}`); return empty; }
}
/* every page of a paged list */
async function pages(c: Ctx, path: string, field: string): Promise<any[]> {
  const out: any[] = [];
  for (let page = 1; page <= 10; page++) {
    const r = await get(c, `${path}${path.includes('?') ? '&' : '?'}page=${page}&pageSize=100`);
    const xs: any[] = (r && r[field]) || [];
    out.push(...xs);
    if (!xs.length || (typeof r.count === 'number' && out.length >= r.count) || xs.length < 100) break;
  }
  return out;
}

type Flavor = {name: string; region_name: string; gpu: string; gpu_count: number; cpu?: number; ram?: number; disk?: number; ephemeral?: number; stock_available?: boolean; display_name?: string};
const flavorsOf = (r: any): Flavor[] => ((r && r.data) || []).flatMap((g: any) => (g.flavors || []).map((f: any) => ({...f, region_name: f.region_name || g.region_name, gpu: f.gpu || g.gpu || ''})));
/* stock per region, GPU model and GPU count, from /core/stocks */
function stockMap(r: any): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of (r && r.stocks) || []) for (const md of s.models || []) for (const [k, v] of Object.entries<any>(md.configurations || {})) m.set(`${s.region}|${String(md.model).toLowerCase()}|${k}`, Number(v) || 0);
  return m;
}
const stockOf = (m: Map<string, number>, f: Flavor) => m.get(`${f.region_name}|${String(f.gpu).toLowerCase()}|${f.gpu_count}x`);
function offersOf(fl: Flavor[], st: Map<string, number>): Offer[] {
  const out: Offer[] = [];
  for (const f of fl) {
    if (!f.gpu_count) continue;
    const n = stockOf(st, f);
    // the flavor's own flag decides; the stock count is used where the flag is missing, and reported either way
    const free = f.stock_available === true || (f.stock_available == null && (n || 0) > 0);
    if (free) out.push({config: f.name, region: f.region_name, level: 'yes', note: n != null ? `${n} machine${n === 1 ? '' : 's'} of ${f.gpu_count} GPUs deployable` : undefined});
  }
  return out;
}
/* environments are cached for a few minutes per key: a launch watch only counts regions where it could actually start a machine */
const envCache = new Map<string, {at: number; envs: any[]; keys: any[]}>();
async function envsAndKeys(c: Ctx, fresh = false) {
  const id = c.secret.trim().slice(-12), hit = envCache.get(id);
  if (hit && !fresh && c.now - hit.at < 5 * 60e3) return hit;
  const [envs, keys] = await Promise.all([pages(c, '/core/environments', 'environments'), pages(c, '/core/keypairs', 'keypairs')]);
  const v = {at: c.now, envs, keys};
  envCache.set(id, v);
  return v;
}
const regionOfEnv = (e: any) => (e && (typeof e.region === 'string' ? e.region : e.region && e.region.name)) || '';
const envOfKey = (k: any) => (k && k.environment && (k.environment.name || k.environment)) || '';
function pickImage(images: any[], region: string, wanted?: string) {
  const here = images.filter(i => i.region_name === region);
  if (wanted) { const w = here.find(i => i.name === wanted); if (w) return w.name; }
  const score = (n: string) => (/ubuntu/i.test(n) ? 4 : 0) + (/cuda/i.test(n) ? 2 : 0) + (/docker/i.test(n) ? 1 : 0);
  const best = here.filter(i => score(i.name) >= 4).sort((a, b) => score(b.name) - score(a.name) || String(b.name).localeCompare(String(a.name), undefined, {numeric: true}))[0];
  return best ? best.name : '';
}
const flatImages = (r: any) => ((r && r.images) || []).flatMap((g: any) => (g.images || []).map((i: any) => ({...i, region_name: i.region_name || g.region_name, family: g.type})));

export const hyperstack: Provider = {
  id: 'hyperstack',
  async validate(c) {
    const r = await get(c, '/core/environments?page=1&pageSize=100');
    const meta: Record<string, any> = {environments: ((r && r.environments) || []).length};
    try { const b = await get(c, '/billing/user-credit/credit'), d = b && b.data; if (d && d.credit != null) { meta.credit = Number(d.credit); meta.canCreate = d.can_create_instance; } } catch { /* the balance is a nicety */ }
    return {meta};
  },
  async catalog(c): Promise<Catalog> {
    const notes: string[] = [];
    const [fr, sr] = await Promise.all([get(c, '/core/flavors', true), soft(notes, 'GPU stock', () => get(c, '/core/stocks', true), null as any)]);
    const [regions, ek, imgs, book, credit] = await Promise.all([
      soft(notes, 'regions', () => get(c, '/core/regions').then((r: any) => (r && r.regions) || []), [] as any[]),
      soft(notes, 'environments and SSH keys', () => envsAndKeys(c, true), {at: 0, envs: [] as any[], keys: [] as any[]}),
      soft(notes, 'images', () => get(c, '/core/images').then(flatImages), [] as any[]),
      soft(notes, 'the price book', () => get(c, '/pricebook').then((r: any) => (Array.isArray(r) ? r : (r && r.data) || [])), [] as any[]),
      soft(notes, 'the credit balance', () => get(c, '/billing/user-credit/credit').then((r: any) => (r && r.data) || null), null as any)
    ]);
    const fl = flavorsOf(fr), st = stockMap(sr), rate = new Map<string, number>();
    for (const p of book) if (p && p.name && Number(p.value) > 0) rate.set(String(p.name).toLowerCase(), Number(p.value));
    const cfg = new Map<string, Config>();
    for (const f of fl) {
      if (!f.gpu_count) continue;
      const x = cfg.get(f.name);
      if (x) { if (!x.regions!.includes(f.region_name)) x.regions!.push(f.region_name); x.note = 'Memory and disk differ between regions; shown for ' + x.regions![0]; continue; }
      const per = rate.get(String(f.gpu).toLowerCase());
      const vram = String(f.gpu).match(/(\d+)G/);
      cfg.set(f.name, {id: f.name, name: `${f.gpu_count}x ${String(f.gpu).replace(/-/g, ' ')}`, gpu: String(f.gpu).replace(/-\d+G/, '').replace(/-/g, ' '), gpus: f.gpu_count,
        vcpus: f.cpu, ramGb: f.ram, diskGb: (f.disk || 0) + (f.ephemeral || 0) || undefined, vramGb: vram ? Number(vram[1]) : undefined,
        price: per ? round2(per * f.gpu_count) : undefined, currency: 'USD', regions: [f.region_name],
        note: per ? 'Price: the price book rate for this GPU times the number of GPUs' : undefined});
    }
    const envRegion = new Map(ek.envs.map((e: any) => [e.name, regionOfEnv(e)]));
    const regionsWithKey = new Set(ek.keys.map((k: any) => envRegion.get(envOfKey(k))).filter(Boolean));
    const gpuRegions = [...new Set(fl.filter(f => f.gpu_count).map(f => f.region_name))];
    const missing = gpuRegions.filter(g => !regionsWithKey.has(g));
    if (missing.length) notes.push(`To start machines in ${missing.join(', ')} you need an environment there with an SSH key in it (Hyperstack console: Environments, then SSH keys). A launch watch skips those regions until then.`);
    if (credit && credit.credit != null) notes.push(`Credit: $${round2(Number(credit.credit))}.${credit.can_create_instance === false ? ' Hyperstack says this account cannot create machines right now: top up first.' : ''}`);
    notes.push('Hyperstack bills by the minute while a machine is on; a hibernated machine stops GPU billing but keeps its disk billed.');
    const rname = new Map<string, string>(regions.map((r: any) => [r.name, r.description || r.country || r.name]));
    return {configs: [...cfg.values()].sort((a, b) => b.gpus - a.gpus || (b.price || 0) - (a.price || 0)), offers: offersOf(fl, st), at: c.now, notes,
      regions: gpuRegions.sort().map(id => ({id, name: rname.get(id) && rname.get(id) !== id ? `${rname.get(id)} (${id})` : id})),
      options: {
        environments: ek.envs.map((e: any) => ({id: e.name, name: `${e.name} (${regionOfEnv(e)})`, region: regionOfEnv(e)})),
        keypairs: ek.keys.map((k: any) => ({id: k.name, name: `${k.name} (${envOfKey(k)})`, region: envRegion.get(envOfKey(k)), detail: envOfKey(k)})),
        images: imgs.map((i: any) => ({id: i.name, name: `${i.name} (${i.region_name})`, region: i.region_name}))
      }};
  },
  async offers(c, w) {
    const [fr, sr] = await Promise.all([get(c, '/core/flavors', true), get(c, '/core/stocks', true).catch(() => null)]);
    let out = offersOf(flavorsOf(fr), stockMap(sr));
    if ((w as any).mode === 'launch') {
      // a region with no environment and key cannot start anything; seeing capacity there would only end in a refused launch
      const ek = await envsAndKeys(c).catch(() => null);
      if (ek) { const er = new Map(ek.envs.map((e: any) => [e.name, regionOfEnv(e)])), ok = new Set(ek.keys.map((k: any) => er.get(envOfKey(k)))); out = out.filter(o => ok.has(o.region)); }
    }
    return out;
  },
  async launch(c, p: LaunchPlan) {
    const s = p.spec.launch || {}, name = vmName(p.name);
    const ek = await prep(envsAndKeys(c, true));
    const env = (s.environment && ek.envs.find((e: any) => e.name === s.environment && regionOfEnv(e) === p.region)) || ek.envs.find((e: any) => regionOfEnv(e) === p.region && ek.keys.some((k: any) => envOfKey(k) === e.name));
    if (!env) throw new ProviderError('invalid', `No environment with an SSH key in ${p.region}. Create one in the Hyperstack console.`);
    const key = (s.keypair && ek.keys.find((k: any) => k.name === s.keypair && envOfKey(k) === env.name)) || ek.keys.find((k: any) => envOfKey(k) === env.name);
    if (!key) throw new ProviderError('invalid', `The environment ${env.name} has no SSH key. Add one in the Hyperstack console.`);
    const images = flatImages(await prep(get(c, '/core/images?region=' + encodeURIComponent(p.region))));
    const image = pickImage(images, p.region, s.image);
    if (!image) throw new ProviderError('invalid', `No Ubuntu image found in ${p.region}. Choose an image in the launch settings.`);
    const body: Record<string, unknown> = {name, environment_name: env.name, flavor_name: p.config, image_name: image, key_name: key.name, count: 1,
      assign_floating_ip: s.public_ip !== false, labels: ['apicheck']};
    if (s.open_ssh !== false) body.security_rules = [{direction: 'ingress', protocol: 'tcp', ethertype: 'IPv4', remote_ip_prefix: '0.0.0.0/0', port_range_min: 22, port_range_max: 22}];
    if (s.user_data) body.user_data = s.user_data;
    const r = await call(c, BASE + '/core/virtual-machines', {method: 'POST', body: JSON.stringify(body), headers: H(c), timeout: 45000}, classify);
    const vm = r && Array.isArray(r.instances) && r.instances[0];
    if (!vm || vm.id == null) throw new ProviderError('http', 'Hyperstack accepted the request but returned no machine id.' + (r && r.message ? ' ' + r.message : ''));
    const id = String(vm.id);
    // a machine that cannot be placed ends in ERROR shortly after it is accepted; it is deleted, and the hunt goes on
    let status = String(vm.status || '');
    for (let i = 0; i < 12 && !/^(ACTIVE|ERROR)$/i.test(status); i++) {
      await sleep(5000);
      const x = await get(c, '/core/virtual-machines/' + encodeURIComponent(id)).catch(() => null), inst = x && (x.instance || x);
      if (inst && inst.status) status = String(inst.status);
    }
    if (/^ERROR$/i.test(status)) {
      await call(c, BASE + '/core/virtual-machines/' + encodeURIComponent(id), {method: 'DELETE', headers: H(c)}, classify).catch(() => null);
      throw new ProviderError('capacity', `The machine went into ERROR right after it was accepted (most likely no free host); it was deleted.`);
    }
    return {extId: id, name, detail: {status, region: p.region, environment: env.name, image, key: key.name}};
  },
  async find(c, p) {
    const name = vmName(p.name);
    const r = await get(c, '/core/virtual-machines?search=' + encodeURIComponent(name) + '&page=1&pageSize=50');
    const vm = ((r && r.instances) || []).find((x: any) => x && x.name === name);
    return vm && !/^ERROR$/i.test(String(vm.status || '')) ? {extId: String(vm.id), status: vm.status} : null;
  },
  async active(c) {
    return (await pages(c, '/core/virtual-machines', 'instances')).filter((i: any) => i && !/^(DELETED|DELETING)$/i.test(String(i.status || ''))).map((i: any): Machine => ({extId: String(i.id), name: i.name || '', config: (i.flavor && i.flavor.name) || '', region: (i.environment && i.environment.region) || '', status: String(i.status || '')}));
  },
  async preflight(c, spec) {
    const out: Check[] = [], s = spec.launch || {}, ek = await envsAndKeys(c, true), fl = flavorsOf(await get(c, '/core/flavors'));
    const regions: string[] = spec.regions && spec.regions.length ? spec.regions : [...new Set(fl.filter(f => (spec.configs || []).includes(f.name)).map(f => f.region_name))];
    for (const region of regions) {
      const env = (s.environment && ek.envs.find((e: any) => e.name === s.environment && regionOfEnv(e) === region)) || ek.envs.find((e: any) => regionOfEnv(e) === region && ek.keys.some((k: any) => envOfKey(k) === e.name));
      if (!env) { out.push({level: 'fail', text: `${region}: no environment with an SSH key; a launch there is skipped.`}); continue; }
      const key = (s.keypair && ek.keys.find((k: any) => k.name === s.keypair && envOfKey(k) === env.name)) || ek.keys.find((k: any) => envOfKey(k) === env.name);
      const image = pickImage(flatImages(await get(c, '/core/images?region=' + encodeURIComponent(region))), region, s.image);
      out.push(key && image ? {level: 'ok', text: `${region}: environment ${env.name}, key ${key.name}, image ${image}.`} : {level: 'fail', text: `${region}: ${key ? 'no Ubuntu image' : 'no SSH key in ' + env.name}.`});
    }
    try { const b = await get(c, '/billing/user-credit/credit'), d = b && b.data; if (d && d.can_create_instance === false) out.push({level: 'fail', text: 'Hyperstack says this account cannot create machines now: top up the credit.'}); else if (d && d.credit != null) out.push({level: 'ok', text: `Credit $${round2(Number(d.credit))}.`}); } catch { /* optional */ }
    return out;
  },
  async instance(c, extId) {
    const x = await get(c, '/core/virtual-machines/' + encodeURIComponent(extId)), i = x && (x.instance || x);
    if (!i || i.id == null) return null;
    return {status: i.status, ip: i.floating_ip || null, privateIp: i.fixed_ip || null, flavor: i.flavor && i.flavor.name, region: i.environment && i.environment.region};
  }
};
