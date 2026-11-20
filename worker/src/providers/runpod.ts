// RunPod, REST v2 (https://api.runpod.io/v2; REST v1 was retired on 15.11.2026 and GraphQL is deprecated).
// Availability: GET /v2/catalog/gpus?include=AVAILABILITY&product=POD&count=N&cloud=C gives a stock level per GPU type and per data center.
// Launch: POST /v2/pods. 400 = could not be placed (no capacity), 402 = balance, 403 = no access to that pool, 422 = bad request, 429 = slow down.
// Docs read 20.11.2026: https://docs.runpod.io/api-reference-v2/
import {ProviderError} from '../types';
import type {Provider, Ctx, Catalog, Config, Offer, Level, Check, Machine} from '../types';
import {call, round2} from './net';
import type {Classify} from './net';

const BASE = 'https://api.runpod.io/v2';
/* the image used when none is chosen: RunPod's official PyTorch 2.8 on CUDA 12.8.1, Ubuntu 24.04; it needs a host with CUDA 12.8 or newer */
export const DEFAULT_IMAGE = 'runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404';
/** the CUDA version an image tag names, RunPod style: cu1281 → 12.8, cu1300 → 13.0, cuda12.8.1 → 12.8 */
export const cudaOf = (image: string) => { const m = String(image).match(/cu(?:da)?[:-]?(1\d)\.?(\d)/i); return m ? `${m[1]}.${m[2]}` : ''; };
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
    else if (!s.template && cudaOf(s.image || DEFAULT_IMAGE)) gpu.minCudaVersion = cudaOf(s.image || DEFAULT_IMAGE);   // an image built for CUDA 12.8 on an older host starts a pod that cannot use its GPUs
    if (s.min_ram) gpu.minRamPerGpu = s.min_ram;
    if (s.min_vcpu) gpu.minVcpuCountPerGpu = s.min_vcpu;
    // the data center that showed capacity first, then every other one the watch allows: one request covers them all
    const dcs = [p.region, ...((p.spec.regions || []) as string[]).filter(r => r !== p.region)];
    const body: Record<string, unknown> = {name: p.name, gpu, cloud, dataCenterIds: dcs, ports: String(s.ports || '22/tcp').split(/[\s,]+/).filter(Boolean), startSsh: s.start_ssh !== false};
    if (s.template) body.templateId = s.template; else body.image = s.image || DEFAULT_IMAGE;
    if (s.disk) body.disk = s.disk;
    if (s.network_volume) body.mounts = {network: [{volumeId: s.network_volume, path: s.volume_path || '/workspace'}]};
    const env: Record<string, string> = {};
    for (const line of String(s.env || '').split('\n')) { const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/); if (m) env[m[1]] = m[2].trim(); }
    if (Object.keys(env).length) body.env = env;
    if (s.start_cmd) body.args = s.start_cmd;
    const r = await call(c, BASE + '/pods', {method: 'POST', body: JSON.stringify(body), headers: H(c), timeout: 30000}, classify).catch(e => {
      // 403 on a create: "your account cannot access the requested pool"; the docs say skip that candidate and keep going
      if (e instanceof ProviderError && e.status === 403) throw new ProviderError('capacity', 'No access to this pool: ' + e.message, 403);
      throw e;
    });
    if (!r || !r.id) throw new ProviderError('http', 'RunPod accepted the request but returned no pod id.');
    // RunPod calls dataCenterIds a preference. A pod placed outside the chosen data centers is terminated at once, and the hunt goes on.
    const allowed: string[] = p.spec.regions || [];
    if (allowed.length && r.dataCenterId && !allowed.includes(r.dataCenterId)) {
      const gone = await call(c, BASE + '/pods/' + encodeURIComponent(r.id), {method: 'DELETE', headers: H(c), timeout: 20000}, classify).then(() => true, () => false);
      if (gone) throw Object.assign(new ProviderError('capacity', `RunPod placed the pod in ${r.dataCenterId}, outside the chosen data centers; it was terminated at once.`), {terminated: r.id});
      return {extId: r.id, name: r.name || p.name, price: typeof r.cost === 'number' ? round2(r.cost) : undefined, currency: 'USD',
        detail: {status: r.status, dataCenter: r.dataCenterId, cloud, warning: `RunPod placed the pod in ${r.dataCenterId}, outside the chosen data centers, and it could not be terminated. Terminate it in the RunPod console if you do not want it.`}};
    }
    return {extId: r.id, name: r.name || p.name, price: typeof r.cost === 'number' ? round2(r.cost) : undefined, currency: 'USD', detail: {status: r.status, dataCenter: r.dataCenterId || p.region, cloud}};
  },
  async find(c, p) {
    let cursor = '';
    for (let i = 0; i < 5; i++) {
      const r = await get(c, '/pods?limit=200' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
      const list: any[] = Array.isArray(r) ? r : (r && (r.pods || r.data || r.items)) || [];
      const x = list.find(q => q && q.name === p.name);
      if (x) return {extId: x.id, status: x.status || x.desiredStatus};
      if (!r || !r.pagination || !r.pagination.hasNextPage || !r.pagination.nextCursor) break;
      cursor = r.pagination.nextCursor;
    }
    return null;
  },
  async active(c) {
    const r = await get(c, '/pods?limit=1000'), list: any[] = (r && r.pods) || [];
    return list.filter(x => x && x.status !== 'TERMINATED').map((x): Machine => ({extId: x.id, name: x.name || '', config: x.gpu ? x.gpu.id : 'cpu', gpus: x.gpu ? x.gpu.count : 0, region: x.dataCenterId || '', status: x.status}));
  },
  async preflight(c, spec) {
    const out: Check[] = [], s = spec.launch || {}, {count, cloud} = params(c, spec), key = cloud === 'SECURE' ? 'secure' : 'community', regions: string[] = spec.regions || [];
    const gpus = await listGpus(c, count, cloud);
    let hour = 0;
    for (const id of spec.configs || []) {
      const g = gpus.find((x: any) => x.id === id);
      if (!g || !g[key]) { out.push({level: 'fail', text: `RunPod does not sell ${id} on ${cloud === 'SECURE' ? 'Secure' : 'Community'} Cloud.`}); continue; }
      const max = g.maxCount ? g.maxCount[key] : 0, one = g.price ? g.price[key] : 0;
      if (max && max < count) out.push({level: 'fail', text: `The largest ${g.name} machine has ${max} GPUs; ${count} cannot be placed.`});
      else out.push({level: 'ok', text: `${count}x ${g.name}: $${round2(one * count)}/h.`});
      hour = Math.max(hour, one * count);
    }
    if (regions.length) {
      const dcs: any[] = await get(c, '/catalog/datacenters').then((r: any) => (r && r.dataCenters) || [], () => []);
      const unknown = dcs.length ? regions.filter(r => !dcs.some(d => d.id === r)) : [];
      if (unknown.length) out.push({level: 'warn', text: `RunPod does not list ${unknown.join(', ')} as data centers.`});
    }
    out.push({level: 'warn', text: 'RunPod treats the chosen data centers as a preference. If it places the pod anywhere else, API Check terminates it at once (seconds of billing) and keeps hunting.'});
    try {
      const b = await get(c, '/billing/balance'), bal = Number(b && b.balanceAmount);
      if (b && b.billingMode === 'POSTPAID') out.push({level: 'ok', text: 'Post-paid billing.'});
      else if (hour && bal < hour) out.push({level: 'fail', text: `Balance $${round2(bal)} is less than one hour of the machine ($${round2(hour)}); RunPod refuses the launch (402). Top up, or turn on automatic payments.`});
      else if (hour && bal < hour * 3) out.push({level: 'warn', text: `Balance $${round2(bal)} covers less than three hours of the machine ($${round2(hour)}/h). When it runs out, a pod without a network volume is terminated and its data is lost.`});
      else out.push({level: 'ok', text: `Balance $${round2(bal)}.`});
    } catch (e) { out.push({level: 'warn', text: 'Could not read the balance (the key needs billing:read): ' + (e as Error).message}); }
    try {
      const l = await get(c, '/account/limits'), lim = l && l.spendRate;
      if (lim && typeof lim.limit === 'number' && hour && lim.limit - (lim.current || 0) < hour) out.push({level: 'fail', text: `Spend limit $${lim.limit}/h with $${round2(lim.current || 0)}/h in use leaves less than the machine's $${round2(hour)}/h; RunPod refuses the launch. Ask RunPod support to raise it.`});
      else if (lim && typeof lim.limit === 'number') out.push({level: 'ok', text: `Spend limit $${lim.limit}/h, $${round2(lim.current || 0)}/h in use.`});
    } catch (e) { out.push({level: 'warn', text: 'Could not read the spend limit (the key needs account:read): ' + (e as Error).message}); }
    if (s.start_ssh !== false) {
      try {
        const k = await get(c, '/account/ssh-keys'), n = (k && k.keys && k.keys.length) || 0;
        out.push(n ? {level: 'ok', text: `${n} SSH key${n === 1 ? '' : 's'} registered; the pod gets them.`} : {level: 'fail', text: 'No SSH public key is registered at RunPod, so the pod would have no SSH access. Add one in the RunPod console (Settings, SSH public keys).'});
      } catch (e) { out.push({level: 'warn', text: 'Could not read the registered SSH keys: ' + (e as Error).message}); }
      if (!String(s.ports || '22/tcp').split(/[\s,]+/).includes('22/tcp')) out.push({level: 'warn', text: 'Port 22/tcp is not exposed: SSH works only through RunPod\'s proxy (no scp or rsync).'});
    }
    if (s.network_volume) {
      const v = (await all(c, '/network-volumes', 'networkVolumes').catch(() => [] as any[])).find((x: any) => x.id === s.network_volume);
      if (!v) out.push({level: 'fail', text: 'The chosen network volume does not exist any more.'});
      else if (regions.length && !regions.includes(v.dataCenter || v.dataCenterId)) out.push({level: 'fail', text: `The network volume is in ${v.dataCenter || v.dataCenterId}, outside the chosen data centers.`});
      else out.push({level: 'ok', text: `Network volume "${v.name}" in ${v.dataCenter || v.dataCenterId}; the pod can only start there.`});
    }
    if (s.template) {
      try { const t = await get(c, '/templates/' + encodeURIComponent(s.template)); out.push({level: 'ok', text: `Template "${(t && t.name) || s.template}"${t && t.image ? ' (' + t.image + ')' : ''}.`}); }
      catch (e) { out.push({level: 'fail', text: 'The chosen template cannot be read: ' + (e as Error).message}); }
    } else {
      const img = s.image || DEFAULT_IMAGE, cu = s.min_cuda || cudaOf(img);
      out.push({level: 'ok', text: `Image ${img}${img === DEFAULT_IMAGE ? ' (RunPod\'s official PyTorch)' : ''}${cu ? `; the launch asks for a host with CUDA ${cu} or newer` : ''}.`});
      if (img !== DEFAULT_IMAGE) out.push({level: 'warn', text: 'API Check cannot check that a custom image exists; a wrong name leaves the pod failing to start.'});
    }
    return out;
  },
  async instance(c, extId) {
    const p = await get(c, '/pods/' + encodeURIComponent(extId));
    if (!p) return null;
    const ssh = p.ssh && (p.ssh.direct ? p.ssh.direct.command : p.ssh.proxy ? p.ssh.proxy.command : null);
    return {status: p.status, ip: p.ssh && p.ssh.direct ? p.ssh.direct.host : null, ssh, cost: p.cost, dataCenter: p.dataCenterId, gpus: p.gpu ? `${p.gpu.count} GPUs, ${p.gpu.vcpuCount} vCPU, ${p.gpu.memory} GB RAM` : null};
  }
};
