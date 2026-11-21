// Gcore GPU Cloud. API: https://api.gcore.com, "Authorization: APIKey <token>" (a permanent API token from the Gcore Customer Portal).
// Read 21.11.2026 from the official Python SDK, generated from Gcore's OpenAPI (github.com/G-Core/gcore-python: resources/cloud/gpu_baremetal,
//   gpu_virtual, tasks, quotas, regions, projects, ssh_keys) and docs.gcore.com.
// Two kinds of GPU machine: bare metal servers and virtual machines, both made as a "cluster" of N servers (N = 1 here).
// Availability: GET /cloud/v3/gpu/{baremetal|virtual}/{project}/{region}/flavors gives every flavor with "capacity", the number of instances
//   of that flavor available to the client now, and "disabled". The same call with include_prices=true carries the hourly price.
// Launch: POST /cloud/v3/gpu/{kind}/{project}/{region}/clusters {name, flavor, servers_count: 1, servers_settings, image_id (bare metal)}
//   returns {tasks: [id]}; GET /cloud/v1/tasks/{id} ends FINISHED (created_resources.ai_clusters) or ERROR (error).
// Quotas: GET /cloud/v2/client_quotas has, per region, baremetal_gpu_h100_count_limit/usage (servers) and gpu_virtual_h100_count_limit/usage.
// No rate limit is published; errors carry a "message".
import {ProviderError} from '../types';
import type {Provider, Ctx, Catalog, Config, Offer, LaunchPlan, Check, Machine} from '../types';
import {call, round2, prep, Unclear} from './net';
import type {Classify} from './net';

const BASE = 'https://api.gcore.com';
/** the token as Gcore wants it: people often copy it with the "APIKey " prefix */
export const tokenOf = (s: string) => s.trim().replace(/^apikey\s+/i, '');
const H = (c: Ctx) => ({authorization: 'APIKey ' + tokenOf(c.secret)});
const KIND_WORDS = (m: string) => {
  if (/balance|funds|payment|billing|debt|insufficient money|top.?up/i.test(m)) return 'money';
  if (/quota|limit|exceed|not (enabled|allowed|permitted)|forbidden/i.test(m)) return 'quota';
  if (/capacity|no (free|available|suitable)|not enough|insufficient|out of stock|unavailable|no valid host|could not be scheduled|sold out/i.test(m)) return 'capacity';
  if (/invalid|must|required|not found|does not exist|already exists|format|unknown/i.test(m)) return 'invalid';
  return '';
};
export const classify: Classify = (status, body, text) => {
  const m = String((body && (body.message || body.detail || body.error)) || text || '');
  if (status === 401) return 'auth';
  if (status === 403) return 'quota';
  if (status === 429) return 'rate';
  if (status === 402) return 'money';
  if (status === 404 || status === 405) return 'invalid';
  if (status === 400 || status === 409 || status === 422) return (KIND_WORDS(m) || 'capacity') as any;
  return null;
};
const get = (c: Ctx, path: string, memo = false) => call(c, BASE + path, {headers: H(c), memo}, classify);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const clusterName = (n: string) => n.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63) || 'apicheck';
async function soft<T>(notes: string[], what: string, fn: () => Promise<T>, empty: T): Promise<T> {
  try { return await fn(); } catch (e) { notes.push(`Could not read ${what}: ${(e as Error).message}`); return empty; }
}
async function list(c: Ctx, path: string, memo = false): Promise<any[]> {
  const out: any[] = [];
  for (let offset = 0, i = 0; i < 10; i++, offset += 1000) {
    const r = await get(c, path + (path.includes('?') ? '&' : '?') + `limit=1000&offset=${offset}`, memo);
    const xs: any[] = (r && r.results) || [];
    out.push(...xs);
    if (xs.length < 1000 || (typeof r.count === 'number' && out.length >= r.count)) break;
  }
  return out;
}
type Kind = 'baremetal' | 'virtual';
/* a configuration id says which kind it is: bm:<flavor> or vm:<flavor> */
export const cfgId = (k: Kind, flavor: string) => (k === 'baremetal' ? 'bm:' : 'vm:') + flavor;
export const parseCfg = (id: string): {kind: Kind; flavor: string} => ({kind: id.startsWith('vm:') ? 'virtual' : 'baremetal', flavor: id.replace(/^(bm|vm):/, '')});
/* RAM is a free-text description on bare metal ("2TB", "2048 GB") and a number on virtual flavors */
export function ramOf(v: unknown): number | undefined {
  if (typeof v === 'number') return v > 100000 ? Math.round(v / 1024) : v;
  const m = String(v || '').match(/([\d.]+)\s*(T|G|M)i?B/i);
  if (!m) return undefined;
  const n = Number(m[1]), u = m[2].toUpperCase();
  return Math.round(u === 'T' ? n * 1024 : u === 'M' ? n / 1024 : n);
}
/* the project the key works in: the one the person chose, or the default project */
async function project(c: Ctx): Promise<{id: number; client: number; name: string}> {
  if (c.meta && c.meta.project) return {id: Number(c.meta.project), client: Number(c.meta.client || 0), name: c.meta.projectName || ''};
  const ps = await list(c, '/cloud/v1/projects', true);
  const p = ps.find((x: any) => x.is_default && x.state !== 'DELETED') || ps.find((x: any) => x.state !== 'DELETED');
  if (!p) throw new ProviderError('invalid', 'The Gcore account has no cloud project. Open GPU Cloud in the Gcore portal once to create one.');
  return {id: p.id, client: p.client_id, name: p.name};
}
/* GPU regions are cached for ten minutes per key: the region list changes rarely and every check would otherwise ask for it */
const regionCache = new Map<string, {at: number; regions: any[]}>();
async function gpuRegions(c: Ctx): Promise<any[]> {
  const id = tokenOf(c.secret).slice(-12), hit = regionCache.get(id);
  if (hit && c.now - hit.at < 10 * 60e3) return hit.regions;
  const regions = (await list(c, '/cloud/v1/regions', true)).filter((r: any) => r.has_ai_gpu && (!r.state || r.state === 'ACTIVE'));
  regionCache.set(id, {at: c.now, regions});
  return regions;
}
async function flavors(c: Ctx, p: number, region: string | number, kind: Kind, prices = false): Promise<any[]> {
  return list(c, `/cloud/v3/gpu/${kind}/${p}/${region}/flavors?hide_disabled=true${prices ? '&include_prices=true' : ''}`, true);
}
function offerOf(f: any, kind: Kind, region: string): Offer | null {
  if (!f || f.disabled || !(Number(f.capacity) > 0)) return null;
  return {config: cfgId(kind, f.name), region, level: 'yes', note: `${f.capacity} available`};
}
/* the regions and kinds a watch needs asked about */
function plan(spec: any, all: any[]): {regions: string[]; kinds: Kind[]} {
  const targets: string[] = spec.configs || [];
  const kinds: Kind[] = targets.length ? [...new Set(targets.map(t => parseCfg(t).kind))] : ['baremetal', 'virtual'];
  const regions: string[] = spec.regions && spec.regions.length ? spec.regions : all.map((r: any) => String(r.id));
  return {regions, kinds};
}
async function offersFor(c: Ctx, p: number, regions: string[], kinds: Kind[]): Promise<Offer[]> {
  const jobs = regions.flatMap(r => kinds.map(k => flavors(c, p, r, k).then(fs => fs.map(f => offerOf(f, k, r)).filter(Boolean) as Offer[]).catch(e => {
    if (e instanceof ProviderError && (e.kind === 'auth' || e.kind === 'rate')) throw e;
    return [] as Offer[];   // a region without that kind of GPU answers 404; it simply has nothing to offer
  })));
  return (await Promise.all(jobs)).flat();
}
/* an image for the cluster: the chosen one, or the newest Ubuntu with a GPU driver */
export function pickImage(images: any[], wanted?: string) {
  if (wanted) { const w = images.find(i => i.id === wanted); if (w) return w; }
  const ok = images.filter(i => (!i.status || /active/i.test(i.status)) && /ubuntu/i.test(`${i.os_distro || ''} ${i.name || ''}`) && (!i.architecture || /x86/i.test(i.architecture)));
  const score = (i: any) => (i.gpu_driver || /cuda|nvidia|driver/i.test(i.name || '') ? 2 : 0);
  return ok.sort((a, b) => score(b) - score(a) || String(b.os_version || b.name).localeCompare(String(a.os_version || a.name), undefined, {numeric: true}))[0] || null;
}
const images = (c: Ctx, p: number, region: string, kind: Kind) => list(c, `/cloud/v3/gpu/${kind}/${p}/${region}/images`);
const sshKeys = (c: Ctx, p: number) => list(c, `/cloud/v1/ssh_keys/${p}`);
const b64 = (s: string) => btoa(unescape(encodeURIComponent(s)));
const quotaKey = (kind: Kind, model: string) => { const m = String(model || '').toLowerCase().match(/a100|h100|h200|l40s/); return m ? (kind === 'baremetal' ? `baremetal_gpu_${m[0]}_count` : `gpu_virtual_${m[0]}_count`) : ''; };
async function clusters(c: Ctx, p: number, region: string, kind: Kind) {
  return list(c, `/cloud/v3/gpu/${kind}/${p}/${region}/clusters`);
}
const createdId = (t: any) => { const r = (t && t.created_resources) || {}; return (r.ai_clusters && r.ai_clusters[0]) || (r.clusters && r.clusters[0]) || ''; };

export const gcore: Provider = {
  id: 'gcore',
  async validate(c) {
    const p = await project(c);
    return {meta: {project: p.id, client: p.client, projectName: p.name}, account: `${p.name || 'project ' + p.id} (client ${p.client})`};
  },
  async catalog(c): Promise<Catalog> {
    const notes: string[] = [];
    const p = await project(c), regions = await gpuRegions(c);
    const cfg = new Map<string, Config>(), offers: Offer[] = [];
    const [keys, quota] = await Promise.all([
      soft(notes, 'SSH keys', () => sshKeys(c, p.id), [] as any[]),
      soft(notes, 'quotas', () => get(c, '/cloud/v2/client_quotas'), null as any)
    ]);
    const imgs: {id: string; name: string; region: string; detail?: string}[] = [];
    await Promise.all(regions.flatMap((r: any) => (['baremetal', 'virtual'] as Kind[]).map(async kind => {
      let fs: any[] = [];
      try { fs = await flavors(c, p.id, r.id, kind, true); } catch { return; }
      const gpu = fs.filter(f => f.hardware_properties && f.hardware_properties.gpu_count);
      if (!gpu.length) return;
      for (const f of gpu) {
        const id = cfgId(kind, f.name), hp = f.hardware_properties || {}, hd = f.hardware_description || {}, pr = f.price || {};
        const o = offerOf(f, kind, String(r.id)); if (o) offers.push(o);
        const x = cfg.get(id);
        if (x) { if (!x.regions!.includes(String(r.id))) x.regions!.push(String(r.id)); continue; }
        const model = String(hp.gpu_model || hd.gpu || 'GPU').replace(/^NVIDIA\s*/i, '');
        cfg.set(id, {id, name: `${hp.gpu_count}x ${model} ${kind === 'baremetal' ? 'bare metal' : 'VM'}`, gpu: model, gpus: hp.gpu_count, vcpus: typeof hd.vcpus === 'number' ? hd.vcpus : undefined,
          ramGb: ramOf(hd.ram), vramGb: /h100|a100/i.test(model) ? 80 : /h200/i.test(model) ? 141 : undefined,
          price: pr.price_status !== 'hide' && pr.price_per_hour ? round2(pr.price_per_hour) : undefined, currency: pr.currency_code || 'EUR', regions: [String(r.id)],
          note: [typeof hd.ram === 'string' ? 'RAM ' + hd.ram : '', hd.cpu, hd.disk ? 'disks ' + hd.disk : '', hd.ephemeral ? 'local ' + hd.ephemeral : '', hp.nic_ib ? 'InfiniBand ' + hp.nic_ib : '', hd.network ? 'network ' + hd.network : '', hp.nic_eth ? 'Ethernet ' + hp.nic_eth : ''].filter(Boolean).join('; ') || undefined});
      }
      try { for (const i of await images(c, p.id, String(r.id), kind)) imgs.push({id: i.id, name: `${i.name} (${r.display_name}, ${kind === 'baremetal' ? 'bare metal' : 'VM'})`, region: String(r.id), detail: kind}); } catch { /* images are optional */ }
    })));
    if (!keys.length) notes.push('There is no SSH key in this Gcore project (Cloud, SSH keys). Add one, or the machine cannot be reached.');
    const rq: any[] = (quota && quota.regional_quotas) || [];
    for (const q of rq) {
      const r = regions.find((x: any) => x.id === q.region_id); if (!r) continue;
      const lim = Number(q.baremetal_gpu_h100_count_limit || 0), used = Number(q.baremetal_gpu_h100_count_usage || 0);
      if (lim === 0 && cfg.size) notes.push(`${r.display_name}: the H100 bare metal quota is 0. Ask Gcore to raise it (Cloud, Quotas) before you rely on a launch watch there.`);
      else if (lim) notes.push(`${r.display_name}: H100 bare metal servers ${used} of ${lim} allowed.`);
    }
    notes.push(`Project: ${p.name || p.id}. Gcore bills GPU machines by the minute while they exist; prices are in the currency Gcore shows (usually EUR, before VAT).`);
    return {configs: [...cfg.values()].sort((a, b) => b.gpus - a.gpus || (b.price || 0) - (a.price || 0)), offers, at: c.now, notes, account: `${p.name || p.id}`,
      regions: regions.filter((r: any) => [...cfg.values()].some(x => x.regions!.includes(String(r.id)))).map((r: any) => ({id: String(r.id), name: `${r.display_name}${r.country ? ', ' + r.country : ''} (${r.id})`})),
      options: {sshKeys: keys.map((k: any) => ({id: k.name, name: k.name})), images: imgs}};
  },
  async offers(c, w) {
    const p = await project(c), all = await gpuRegions(c), q = plan(w.spec || {}, all);
    return offersFor(c, p.id, q.regions, q.kinds);
  },
  async launch(c, lp: LaunchPlan) {
    const s = lp.spec.launch || {}, name = clusterName(lp.name), {kind, flavor} = parseCfg(lp.config);
    const p = await prep(project(c));
    const [imgs, keys] = await prep(Promise.all([images(c, p.id, lp.region, kind), sshKeys(c, p.id)]));
    const image = pickImage(imgs, s.image_region === lp.region || !s.image_region ? s.image : undefined);
    if (!image) throw new ProviderError('invalid', `No Ubuntu image for ${kind === 'baremetal' ? 'bare metal' : 'virtual'} GPU machines in region ${lp.region}. Choose an image in the launch settings.`, 1);
    const key = s.ssh_key ? keys.find((k: any) => k.name === s.ssh_key) : keys[0];
    if (!key) throw new ProviderError('invalid', s.ssh_key ? 'The chosen SSH key is no longer in the Gcore project.' : 'There is no SSH key in the Gcore project. Add one first.', 1);
    const settings: Record<string, unknown> = {interfaces: [{type: 'external', ip_family: 'ipv4'}], credentials: {ssh_key_name: key.name}};
    if (s.user_data) settings.user_data = b64(s.user_data);
    const body: Record<string, unknown> = {name, flavor, servers_count: 1, servers_settings: settings, tags: {apicheck: '1'}};
    if (kind === 'baremetal') body.image_id = image.id;
    else settings.volumes = [{source: 'image', image_id: image.id, boot_index: 0, size: Number(s.disk_size) || 200, type: 'ssd_hiiops', name: name + '-boot', delete_on_termination: true}];
    const path = `/cloud/v3/gpu/${kind}/${p.id}/${lp.region}/clusters`;
    const r = await call(c, BASE + path, {method: 'POST', body: JSON.stringify(body), headers: H(c), timeout: 45000}, classify);
    const task = r && Array.isArray(r.tasks) && r.tasks[0];
    if (!task) throw new ProviderError('http', 'Gcore accepted the request but returned no task.');
    // the task tells whether a server was found for the cluster; it is followed for up to four minutes
    let t: any = null;
    const until = Date.now() + 240e3;
    for (let first = true; Date.now() < until; first = false) {
      if (!first) await sleep(5000);
      t = await get(c, '/cloud/v1/tasks/' + encodeURIComponent(task)).catch(() => t);
      if (t && (t.state === 'FINISHED' || t.state === 'ERROR')) break;
    }
    let id = createdId(t);
    if (t && t.state === 'ERROR') {
      // a half-made cluster would keep the account guard shut; it is deleted, found by name if the task did not say its id
      if (!id) { const x = await clusters(c, p.id, lp.region, kind).then(xs => xs.find((k: any) => k && k.name === name)).catch(() => null); if (x) id = String(x.id); }
      if (id) await call(c, BASE + path + '/' + encodeURIComponent(id), {method: 'DELETE', headers: H(c)}, classify).catch(() => null);
      const msg = String(t.error || 'the task ended in ERROR');
      throw new ProviderError((KIND_WORDS(msg) || 'capacity') as any, `Gcore could not create the machine: ${msg}${id ? ' (the half-made cluster was deleted)' : ''}`);
    }
    if (id) return {extId: id, name, detail: {task, state: t && t.state, region: lp.region, kind, image: image.name, key: key.name}};
    // still running with no cluster id yet: the engine asks by name before it does anything else
    throw new Unclear(`Gcore is still working on the request (task ${task}); the machine is looked up by name.`);
  },
  async find(c, lp) {
    const name = clusterName(lp.name), {kind} = parseCfg(lp.config), p = await project(c);
    const x = (await clusters(c, p.id, lp.region, kind)).find((k: any) => k && k.name === name);
    return x ? {extId: String(x.id), status: x.status || 'exists'} : null;
  },
  async active(c) {
    const p = await project(c), regions = await gpuRegions(c), out: Machine[] = [];
    await Promise.all(regions.flatMap((r: any) => (['baremetal', 'virtual'] as Kind[]).map(async kind => {
      let xs: any[] = [];
      try { xs = await clusters(c, p.id, String(r.id), kind); } catch (e) { if (e instanceof ProviderError && (e.kind === 'auth' || e.kind === 'rate' || e.kind === 'http')) throw e; return; }
      for (const x of xs) out.push({extId: String(x.id), name: x.name || '', config: cfgId(kind, x.flavor || ''), region: String(r.id), status: String(x.status || 'exists')});
    })));
    return out;
  },
  async preflight(c, spec) {
    const out: Check[] = [], s = spec.launch || {}, p = await project(c), all = await gpuRegions(c);
    const q = plan(spec, all), keys = await sshKeys(c, p.id);
    const key = s.ssh_key ? keys.find((k: any) => k.name === s.ssh_key) : keys[0];
    out.push(key ? {level: 'ok', text: `SSH key ${key.name}.`} : {level: 'fail', text: s.ssh_key ? 'The chosen SSH key is no longer in the project.' : 'No SSH key in the Gcore project.'});
    let quota: any = null; try { quota = await get(c, '/cloud/v2/client_quotas'); } catch { /* shown as unknown */ }
    for (const region of q.regions) {
      const rname = (all.find((r: any) => String(r.id) === region) || {}).display_name || region;
      for (const cfg of (spec.configs || []).filter((x: string) => q.kinds.includes(parseCfg(x).kind))) {
        const {kind, flavor} = parseCfg(cfg);
        const fs = await flavors(c, p.id, region, kind).catch(() => [] as any[]), f = fs.find((x: any) => x.name === flavor);
        if (!f) { out.push({level: 'warn', text: `${rname}: ${flavor} is not offered here.`}); continue; }
        const im = pickImage(await images(c, p.id, region, kind).catch(() => [] as any[]), s.image_region === region ? s.image : undefined);
        const qk = quotaKey(kind, f.hardware_properties && f.hardware_properties.gpu_model), rq = quota && (quota.regional_quotas || []).find((x: any) => String(x.region_id) === region);
        const lim = rq && qk ? Number(rq[qk + '_limit']) : NaN, used = rq && qk ? Number(rq[qk + '_usage'] || 0) : 0;
        if (!im) out.push({level: 'fail', text: `${rname}: no Ubuntu image for ${flavor}.`});
        else if (Number.isFinite(lim) && lim - used <= 0) out.push({level: 'fail', text: `${rname}: quota for ${flavor} is ${used} of ${lim} used. Ask Gcore to raise it.`});
        else out.push({level: 'ok', text: `${rname}: ${flavor}, image ${im.name}${Number.isFinite(lim) ? `, quota ${used} of ${lim} used` : ''}.`});
      }
    }
    return out;
  },
  async instance(c, extId, region) {
    const p = await project(c);
    for (const kind of ['baremetal', 'virtual'] as Kind[]) {
      const x = await get(c, `/cloud/v3/gpu/${kind}/${p.id}/${region}/clusters/${encodeURIComponent(extId)}`).catch(() => null);
      if (x && x.id) return {status: x.status || 'exists', flavor: x.flavor, servers: x.servers_ids, region, kind};
    }
    throw new ProviderError('invalid', 'Gcore has no such cluster.', 404);
  }
};
