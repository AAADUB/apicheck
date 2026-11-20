// Lambda Cloud. Spec: https://docs.lambda.com/api/cloud (OpenAPI 1.10.0, read 20.11.2026).
// Availability: GET /instance-types lists, for every type, the regions with capacity right now.
// Launch: POST /instance-operations/launch, at most one request every 12 seconds; "insufficient-capacity" means keep trying.
// Limits: about one request per second in general.
import {ProviderError} from '../types';
import type {Provider, Ctx, Catalog, Config, Offer, Option, LaunchPlan, Check, Machine} from '../types';
import {call, round2, gib2gb} from './net';
import type {Classify} from './net';

const BASE = 'https://cloud.lambda.com/api/v1';
const GONE = new Set(['terminated', 'terminating', 'preempted']);
const KIND: Record<string, ProviderError['kind']> = {
  'instance-operations/launch/insufficient-capacity': 'capacity', 'global/rate-limited': 'rate', 'global/invalid-api-key': 'auth',
  'global/account-inactive': 'auth', 'global/quota-exceeded': 'quota', 'global/invalid-parameters': 'invalid', 'global/object-does-not-exist': 'invalid',
  'instance-operations/launch/file-system-in-wrong-region': 'invalid', 'instance-operations/launch/file-system-not-in-vpc': 'invalid', 'global/invalid-address': 'auth'
};
const classify: Classify = (status, body) => {
  const code = body && body.error && body.error.code;
  if (!code && (status === 401 || status === 403)) return 'http';   // no Lambda error body: an edge or proxy answered, not the API
  return (code && KIND[code]) || (String(code || '').startsWith('provider/') ? 'http' : null);
};
const get = (c: Ctx, path: string, memo = false) => call(c, BASE + path, {headers: {authorization: 'Bearer ' + c.secret.trim()}, memo}, classify).then(r => r && r.data);
/* a list the form can live without: a refusal or a rate limit leaves it empty and says so, instead of failing the whole catalogue */
async function soft<T>(notes: string[], what: string, fn: () => Promise<T[]>): Promise<T[]> {
  for (let i = 0; i < 2; i++) {
    try { return await fn(); }
    catch (e) { if (e instanceof ProviderError && e.kind === 'rate' && i === 0) { await new Promise(r => setTimeout(r, 1300)); continue; } notes.push(`Could not read ${what}: ${(e as Error).message}`); return []; }
  }
  return [];
}
const gpuName = (d: string) => d.replace(/\s*\(.*\)\s*/, ' ').replace(/\s+/g, ' ').trim() + (/SXM/i.test(d) ? ' SXM' : /PCIe/i.test(d) ? ' PCIe' : '');
const vram = (d: string) => { const m = d.match(/(\d+)\s*GB/i); return m ? Number(m[1]) : undefined; };

function configs(types: Record<string, any>): Config[] {
  return Object.values(types || {}).map((t: any) => {
    const it = t.instance_type || {}, s = it.specs || {};
    return {id: it.name, name: it.description || it.name, gpu: gpuName(it.gpu_description || ''), gpus: s.gpus || 0, vcpus: s.vcpus, ramGb: s.memory_gib ? gib2gb(s.memory_gib) : undefined,
      diskGb: s.storage_gib ? gib2gb(s.storage_gib) : undefined, vramGb: vram(it.gpu_description || ''), price: typeof it.price_cents_per_hour === 'number' ? round2(it.price_cents_per_hour / 100) : undefined,
      currency: 'USD', note: it.architecture === 'arm64' ? 'Arm (aarch64): needs an Arm image' : undefined} as Config;
  }).filter(x => x.id).sort((a, b) => b.gpus - a.gpus || (b.price || 0) - (a.price || 0));
}
function offersOf(types: Record<string, any>): Offer[] {
  const out: Offer[] = [];
  for (const t of Object.values(types || {}) as any[]) for (const r of t.regions_with_capacity_available || []) out.push({config: t.instance_type.name, region: r.name, level: 'yes'});
  return out;
}

export const lambda: Provider = {
  id: 'lambda',
  async validate(c) {
    const keys = await get(c, '/ssh-keys');
    return {meta: {sshKeys: Array.isArray(keys) ? keys.length : 0}};
  },
  async catalog(c): Promise<Catalog> {
    const notes: string[] = [];
    const types = await get(c, '/instance-types', true);
    const [regions, keys, images, fss, rulesets] = await Promise.all([
      soft(notes, 'regions', () => get(c, '/regions')), soft(notes, 'SSH keys', () => get(c, '/ssh-keys')), soft(notes, 'images', () => get(c, '/images')),
      soft(notes, 'filesystems', () => get(c, '/filesystems')), soft(notes, 'firewall rulesets', () => get(c, '/firewall-rulesets'))
    ]);
    const seen = new Map<string, string>();
    for (const r of regions as any[]) seen.set(r.name, r.description || r.name);
    for (const t of Object.values(types || {}) as any[]) for (const r of t.regions_with_capacity_available || []) if (!seen.has(r.name)) seen.set(r.name, r.description || r.name);
    const fam = new Map<string, Option>();
    for (const im of images as any[]) if (im.family && !fam.has(im.family)) fam.set(im.family, {id: im.family, name: im.name || im.family, detail: im.architecture});
    if (!keys.length) notes.push('This account has no SSH keys yet. Lambda needs exactly one to launch: add one in the Lambda console (SSH keys) and reload.');
    return {
      configs: configs(types), offers: offersOf(types), at: c.now, notes,
      regions: [...seen].map(([id, name]) => ({id, name: `${name} (${id})`})).sort((a, b) => a.id.localeCompare(b.id)),
      options: {
        sshKeys: (keys as any[]).map(k => ({id: k.name, name: k.name})),
        images: [...fam.values()],
        filesystems: (fss as any[]).map(f => ({id: f.name, name: f.name, region: f.region && f.region.name, detail: f.is_in_use ? 'in use' : undefined})),
        firewalls: (rulesets as any[]).map(f => ({id: f.id, name: f.name || f.id, region: f.region && (f.region.name || f.region)}))
      }
    };
  },
  async offers(c) { return offersOf(await get(c, '/instance-types', true)); },
  async launch(c, p: LaunchPlan) {
    const s = p.spec.launch || {};
    if (!s.ssh_key) throw new ProviderError('invalid', 'Choose the SSH key Lambda should put on the machine.');
    const body: Record<string, unknown> = {region_name: p.region, instance_type_name: p.config, ssh_key_names: [s.ssh_key], name: p.name};
    if (s.filesystem) body.file_system_names = [s.filesystem];
    if (s.image) body.image = {family: s.image};
    if (s.firewall) body.firewall_rulesets = [{id: s.firewall}];
    if (s.hostname) body.hostname = s.hostname;
    if (s.user_data) body.user_data = s.user_data;
    body.tags = [{key: 'apicheck', value: p.spec.watchId || 'watch'}];
    const r = await call(c, BASE + '/instance-operations/launch', {method: 'POST', body: JSON.stringify(body), headers: {authorization: 'Bearer ' + c.secret.trim()}, timeout: 30000}, classify);
    const id = r && r.data && r.data.instance_ids && r.data.instance_ids[0];
    if (!id) throw new ProviderError('http', 'Lambda accepted the request but returned no instance id.');
    return {extId: id, name: p.name, detail: {region: p.region}};
  },
  async find(c, p) {
    const list = await get(c, '/instances');
    const i = (Array.isArray(list) ? list : []).find((x: any) => x && x.name === p.name);
    return i ? {extId: i.id, status: i.status} : null;
  },
  async active(c) {
    const list = await get(c, '/instances');
    return (Array.isArray(list) ? list : []).filter((i: any) => i && !GONE.has(i.status)).map((i: any): Machine => ({extId: i.id, name: i.name || '', config: i.instance_type && i.instance_type.name, region: i.region && i.region.name, status: i.status}));
  },
  async preflight(c, spec) {
    // one request a second is Lambda's general limit, so the reads go one after another
    const out: Check[] = [], s = spec.launch || {}, regions: string[] = spec.regions || [], pause = () => new Promise(r => setTimeout(r, (c as any).fast ? 0 : 1100));
    const types = (await get(c, '/instance-types')) || {};
    for (const id of spec.configs || []) {
      const t = types[id];
      if (!t) out.push({level: 'fail', text: `Lambda does not offer ${id} any more.`});
      else out.push({level: 'ok', text: `${t.instance_type.description}: $${round2(t.instance_type.price_cents_per_hour / 100)}/h${t.instance_type.architecture === 'arm64' ? ', Arm' : ''}.`});
    }
    await pause();
    const keys: any[] = (await get(c, '/ssh-keys')) || [];
    if (!s.ssh_key) out.push({level: 'fail', text: 'No SSH key is chosen; Lambda refuses a launch without exactly one.'});
    else if (!keys.some(k => k.name === s.ssh_key)) out.push({level: 'fail', text: `The SSH key "${s.ssh_key}" is not in the account any more.`});
    else out.push({level: 'ok', text: `SSH key "${s.ssh_key}" is in the account.`});
    if (s.image) {
      await pause();
      const images: any[] = (await get(c, '/images')) || [], arch = new Set((spec.configs || []).map((id: string) => types[id] && types[id].instance_type.architecture).filter(Boolean));
      const has = (r: string) => images.some(i => i.family === s.image && (!r || (i.region && i.region.name === r)) && (!arch.size || arch.has(i.architecture)));
      const missing = regions.filter(r => !has(r));
      if (!has('')) out.push({level: 'fail', text: `The image family "${s.image}" does not exist for this machine's architecture.`});
      else if (missing.length) out.push({level: 'fail', text: `The image family "${s.image}" is not offered in ${missing.join(', ')}; a launch there would be refused. Choose the default image or drop those regions.`});
      else out.push({level: 'ok', text: `Image family "${s.image}" is offered in ${regions.length ? 'every chosen region' : 'the account'}.`});
    } else out.push({level: 'ok', text: 'Image: the latest Lambda Stack (Lambda\'s default).'});
    if (s.filesystem) {
      await pause();
      const f = ((await get(c, '/filesystems')) || []).find((x: any) => x.name === s.filesystem);
      if (!f) out.push({level: 'fail', text: `The filesystem "${s.filesystem}" does not exist any more.`});
      else if (regions.length && !regions.includes(f.region && f.region.name)) out.push({level: 'fail', text: `The filesystem "${s.filesystem}" is in ${f.region && f.region.name}, outside the chosen regions.`});
      else out.push({level: 'ok', text: `Filesystem "${s.filesystem}" in ${f.region && f.region.name}; the watch is limited to that region.`});
    }
    if (s.firewall) {
      await pause();
      const f = ((await get(c, '/firewall-rulesets')) || []).find((x: any) => x.id === s.firewall);
      if (!f) out.push({level: 'fail', text: 'The chosen firewall ruleset does not exist any more.'});
      else out.push({level: 'ok', text: `Firewall ruleset "${f.name}" in ${f.region && (f.region.name || f.region)}.`});
    }
    out.push({level: 'warn', text: 'Lambda does not say how many instances an account may run. New accounts are limited until invoices are paid; if this one has never paid an invoice, ask Lambda support to confirm an 8-GPU launch.'});
    await pause();
    return out;
  },
  async instance(c, extId) {
    const i = await get(c, '/instances/' + encodeURIComponent(extId));
    return i ? {status: i.status, ip: i.ip || null, privateIp: i.private_ip || null, hostname: i.hostname || null, jupyter: i.jupyter_url || null, region: i.region && i.region.name} : null;
  }
};
