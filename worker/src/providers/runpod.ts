// RunPod, REST v2 (https://api.runpod.io/v2; REST v1 was retired on 15.11.2026 and GraphQL is deprecated).
// Availability: GET /v2/catalog/gpus?include=AVAILABILITY&product=POD&count=N&cloud=C gives a stock level per GPU type and per data center.
// Launch: POST /v2/pods. 400 = could not be placed (no capacity), 402 = balance, 403 = no access to that pool, 422 = bad request, 429 = slow down.
// Docs read 20.11.2026: https://docs.runpod.io/api-reference-v2/
import {ProviderError} from '../types';
import type {Provider, Ctx, Catalog, Config, Offer, Level} from '../types';
import {call, round2} from './net';
import type {Classify} from './net';

const BASE = 'https://api.runpod.io/v2';
const classify: Classify = status => (status === 400 ? 'capacity' : status === 402 ? 'money' : status === 403 ? 'quota' : status === 422 || status === 404 || status === 409 || status === 413 ? 'invalid' : null);
const H = (c: Ctx) => ({authorization: 'Bearer ' + c.secret.trim()});
const get = (c: Ctx, path: string, memo = false) => call(c, BASE + path, {headers: H(c), memo}, classify);
const LV: Record<string, Level> = {HIGH: 'high', MEDIUM: 'medium', LOW: 'low', NONE: 'none'};
const params = (c: Ctx, spec?: any) => {
  const p = (spec && spec.params) || (c as any).params || {};
  const count = [1, 2, 4, 8].includes(Number(p.count)) ? Number(p.count) : 8, cloud = p.cloud === 'COMMUNITY' ? 'COMMUNITY' : 'SECURE';
  return {count, cloud};
};
const listGpus = (c: Ctx, count: number, cloud: string) => get(c, `/catalog/gpus?include=AVAILABILITY&product=POD&count=${count}&cloud=${cloud}`, true).then(r => (r && r.gpus) || []);
async function soft<T>(notes: string[], what: string, fn: () => Promise<T>, empty: T): Promise<T> {
  try { return await fn(); } catch (e) { notes.push(`Could not read ${what}: ${(e as Error).message}`); return empty; }
}
/* every page of a cursor list, up to a sane cap */
async function all(c: Ctx, path: string, field: string): Promise<any[]> {
  const out: any[] = []; let cursor = '';
  for (let i = 0; i < 5; i++) {
    const r = await get(c, path + (path.includes('?') ? '&' : '?') + 'limit=200' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
    out.push(...((r && r[field]) || []));
    if (!r || !r.pagination || !r.pagination.hasNextPage || !r.pagination.nextCursor) break;
    cursor = r.pagination.nextCursor;
  }
  return out;
}

export const runpod: Provider = {
  id: 'runpod',
  async validate(c) {
    await get(c, '/catalog/gpus?include=AVAILABILITY&product=POD&count=1&cloud=SECURE');
    const meta: Record<string, any> = {};
    try { const b = await get(c, '/billing/balance'); if (b && typeof b.balanceAmount === 'number') meta.balance = b.balanceAmount; } catch { /* the key may lack billing:read; that is fine */ }
    return {meta};
  },
  async catalog(c): Promise<Catalog> {
    const notes: string[] = [], {count, cloud} = params(c), key = cloud === 'SECURE' ? 'secure' : 'community';
    const gpus = await listGpus(c, count, cloud);
    const [dcs, vols, tpls, bal, lim] = await Promise.all([
      soft(notes, 'data centers', () => get(c, '/catalog/datacenters').then(r => (r && r.dataCenters) || []), [] as any[]),
      soft(notes, 'network volumes', () => all(c, '/network-volumes', 'networkVolumes'), [] as any[]),
      soft(notes, 'official templates', () => get(c, '/catalog/templates?source=official').then(r => (r && r.templates) || []), [] as any[]),
      soft(notes, 'the balance (the key needs billing:read)', () => get(c, '/billing/balance'), null as any),
      soft(notes, 'the spend limit (the key needs account:read)', () => get(c, '/account/limits'), null as any)
    ]);
    const configs: Config[] = [], offers: Offer[] = [];
    for (const g of gpus) {
      if (!g[key]) continue;
      const max = g.maxCount ? g.maxCount[key] : undefined, one = g.price ? g.price[key] : undefined;
      configs.push({id: g.id, name: `${count}x ${g.name}`, gpu: g.name, gpus: count, vramGb: g.memory, ramGb: g.minRam || undefined, vcpus: g.minVcpuCount || undefined,
        price: typeof one === 'number' && one > 0 ? round2(one * count) : undefined, currency: 'USD',
        regions: (g.dataCenters || []).map((d: any) => d.id), note: max && max < count ? `Largest ${cloud === 'SECURE' ? 'Secure' : 'Community'} machine has ${max} GPUs` : (g.minRam ? `RAM and vCPU are the smallest machine free now, in total` : undefined)});
      for (const d of g.dataCenters || []) if (LV[d.availability] && LV[d.availability] !== 'none') offers.push({config: g.id, region: d.id, level: LV[d.availability]});
    }
    configs.sort((a, b) => (b.vramGb || 0) - (a.vramGb || 0) || (b.price || 0) - (a.price || 0));
    const regions = dcs.length ? dcs.map((d: any) => ({id: d.id, name: `${d.name || d.id} (${d.id})`})) : [...new Set(gpus.flatMap((g: any) => (g.dataCenters || []).map((d: any) => d.id)))].map((id: any) => ({id, name: id}));
    if (bal && typeof bal.balanceAmount === 'number') notes.push(`Balance: $${round2(bal.balanceAmount)} (${bal.billingMode === 'POSTPAID' ? 'post-paid' : 'prepaid'}). RunPod asks for at least one hour of the machine's price in credit to start it.`);
    if (lim && lim.spendRate && typeof lim.spendRate.limit === 'number') notes.push(`Spend limit: $${lim.spendRate.limit} per hour across everything running, $${round2(lim.spendRate.current || 0)} in use now. A machine above what is left will be refused.`);
    if (cloud === 'COMMUNITY') notes.push('Community Cloud machines are run by hosts, not RunPod; network volumes work only on Secure Cloud.');
    notes.push('A RunPod pod is a container: there is no Docker inside it and only TCP and HTTP reach it.');
    return {configs, regions: regions.sort((a: any, b: any) => a.id.localeCompare(b.id)), offers, at: c.now, notes,
      options: {
        networkVolumes: vols.map((v: any) => ({id: v.id, name: `${v.name} (${v.size} GB)`, region: v.dataCenter || v.dataCenterId})),
        templates: tpls.filter((t: any) => !t.serverless).map((t: any) => ({id: t.id, name: t.name, detail: t.image}))
      }};
  },
  async offers(c, w) {
    const {count, cloud} = params(c, w.spec), out: Offer[] = [], want = new Set<string>(w.spec.configs || []);
    for (const g of await listGpus(c, count, cloud)) if (want.has(g.id)) for (const d of g.dataCenters || []) if (LV[d.availability] && LV[d.availability] !== 'none') out.push({config: g.id, region: d.id, level: LV[d.availability]});
    return out;
  },
  async launch(c, p) {
    const s = p.spec.launch || {}, {count, cloud} = params(c, p.spec);
    const gpu: Record<string, unknown> = {id: p.config, count};
    if (s.min_cuda) gpu.minCudaVersion = s.min_cuda;
    if (s.min_ram) gpu.minRamPerGpu = s.min_ram;
    if (s.min_vcpu) gpu.minVcpuCountPerGpu = s.min_vcpu;
    const body: Record<string, unknown> = {name: p.name, gpu, cloud, dataCenterIds: [p.region], ports: String(s.ports || '22/tcp').split(/[\s,]+/).filter(Boolean), startSsh: s.start_ssh !== false};
    if (s.template) body.templateId = s.template; else body.image = s.image || 'runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404';
    if (s.disk) body.disk = s.disk;
    if (s.network_volume) body.mounts = {network: [{volumeId: s.network_volume, path: s.volume_path || '/workspace'}]};
    const env: Record<string, string> = {};
    for (const line of String(s.env || '').split('\n')) { const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/); if (m) env[m[1]] = m[2].trim(); }
    if (Object.keys(env).length) body.env = env;
    if (s.start_cmd) body.args = s.start_cmd;
    const r = await call(c, BASE + '/pods', {method: 'POST', body: JSON.stringify(body), headers: H(c), timeout: 30000}, classify);
    if (!r || !r.id) throw new ProviderError('http', 'RunPod accepted the request but returned no pod id.');
    return {extId: r.id, name: r.name || p.name, price: typeof r.cost === 'number' ? round2(r.cost) : undefined, currency: 'USD', detail: {status: r.status, dataCenter: r.dataCenterId || p.region, cloud}};
  },
  async instance(c, extId) {
    const p = await get(c, '/pods/' + encodeURIComponent(extId));
    if (!p) return null;
    const ssh = p.ssh && (p.ssh.direct ? p.ssh.direct.command : p.ssh.proxy ? p.ssh.proxy.command : null);
    return {status: p.status, ip: p.ssh && p.ssh.direct ? p.ssh.direct.host : null, ssh, cost: p.cost, dataCenter: p.dataCenterId, gpus: p.gpu ? `${p.gpu.count} GPUs, ${p.gpu.vcpuCount} vCPU, ${p.gpu.memory} GB RAM` : null};
  }
};
