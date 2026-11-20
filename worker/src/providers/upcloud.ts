// UpCloud, API 1.3 (https://api.upcloud.com/1.3). Read 20.11.2026 from the legacy docs and the official Go SDK v8.42 / CLI / Terraform provider.
// Availability: GET /1.3/device/availability -> {zone: {gpu_plans: {plan: {amount}}}} (SDK GetDevicesAvailability, `upctl zone devices`).
//   What `amount` counts is not documented, so it is shown as is and a plan counts as free when it is 1 or more.
// Launch: POST /1.3/server; 409 SERVER_RESOURCES_UNAVAILABLE = no capacity. GPU plans include no disk, so storage is always given.
import {ProviderError} from '../types';
import type {Provider, Ctx, Catalog, Config, Offer} from '../types';
import {call} from './net';
import type {Classify} from './net';

const BASE = 'https://api.upcloud.com/1.3';
const CAPACITY = new Set(['SERVER_RESOURCES_UNAVAILABLE', 'STORAGE_RESOURCES_UNAVAILABLE', 'IP_ADDRESS_RESOURCES_UNAVAILABLE']);
const codeOf = (body: any): string => {
  if (body && body.error && body.error.error_code) return String(body.error.error_code);
  if (body && typeof body.type === 'string') { const t = body.type.split('#').pop() || ''; return t.replace(/^ERROR_/, ''); }
  return '';
};
const classify: Classify = (status, body) => {
  const code = codeOf(body);
  if (CAPACITY.has(code)) return 'capacity';
  if (code === 'SERVER_CREATING_LIMIT_REACHED') return 'rate';
  if (status === 402 || code === 'INSUFFICIENT_CREDITS') return 'money';
  if (status === 401 || code === 'AUTHENTICATION_FAILED') return 'auth';
  if (status === 403 && /LIMIT_REACHED$/.test(code)) return 'quota';
  if (code === 'TRIAL_PLAN') return 'quota';
  if (status === 403) return 'auth';
  if (status === 503 || status >= 500) return 'http';
  return 'invalid';
};
/* a token is sent as Bearer; "user:password" of an API sub-account as Basic */
const H = (c: Ctx) => { const s = c.secret.trim(); return {authorization: s.includes(':') && !s.startsWith('ucat_') ? 'Basic ' + btoa(s) : 'Bearer ' + s}; };
const get = (c: Ctx, path: string, memo = false) => call(c, BASE + path, {headers: H(c), memo}, classify);
async function soft<T>(notes: string[], what: string, fn: () => Promise<T>, empty: T): Promise<T> {
  try { return await fn(); } catch (e) { notes.push(`Could not read ${what}: ${(e as Error).message}`); return empty; }
}
const gpuShort = (m: string) => String(m || '').replace(/^NVIDIA\s+/i, '');
const avail = (c: Ctx) => get(c, '/device/availability', true).then((r: any) => r || {});
function offersOf(av: any): Offer[] {
  const out: Offer[] = [];
  for (const [zone, z] of Object.entries<any>(av)) for (const [plan, d] of Object.entries<any>((z && z.gpu_plans) || {})) {
    const n = Number(d && d.amount) || 0;
    if (n > 0) out.push({config: plan, region: zone, level: n >= 3 ? 'high' : n === 2 ? 'medium' : 'low', note: `${n} free`});
  }
  return out;
}

export const upcloud: Provider = {
  id: 'upcloud',
  async validate(c) {
    const a = await get(c, '/account');
    const acc = (a && a.account) || {}, lim = acc.resource_limits || {};
    return {meta: {account: acc.username || '', credits: acc.credits, gpus: lim.gpus, cores: lim.cores, memoryMiB: lim.memory}, account: acc.username || ''};
  },
  async catalog(c): Promise<Catalog> {
    const notes: string[] = [];
    const [plans, av, zones, tpls, acc, details, prices] = await Promise.all([
      get(c, '/plan').then((r: any) => (r && r.plans && r.plans.plan) || []),
      soft(notes, 'GPU availability', () => avail(c), {} as any),
      soft(notes, 'zones', () => get(c, '/zone').then((r: any) => (r && r.zones && r.zones.zone) || []), [] as any[]),
      soft(notes, 'templates', () => get(c, '/storage/template').then((r: any) => (r && r.storages && r.storages.storage) || []), [] as any[]),
      soft(notes, 'the account', () => get(c, '/account').then((r: any) => (r && r.account) || null), null as any),
      soft(notes, 'the account currency', () => get(c, '/account/details').then((r: any) => (r && r.account) || null), null as any),
      soft(notes, 'prices', () => get(c, '/price').then((r: any) => (r && r.prices && r.prices.zone) || []), [] as any[])
    ]);
    const gpuZones = new Set(Object.keys(av || {}).filter(z => av[z] && av[z].gpu_plans && Object.keys(av[z].gpu_plans).length));
    if (!gpuZones.size) gpuZones.add('fi-hel2');
    const cur = (details && details.currency) || 'EUR';
    const priceOf = (zone: string, plan: string): number | undefined => {
      const z = (prices as any[]).find(p => p.name === zone), p = z && z['server_plan_' + plan];
      // the unit is not documented; it reads as cents per hour, so it is shown only when it gives a believable hourly price
      const v = p && typeof p.price === 'number' ? p.price / 100 : undefined;
      return v && v > 0.01 && v < 500 ? Math.round(v * 100) / 100 : undefined;
    };
    const firstZone = [...gpuZones][0];
    const configs: Config[] = (plans as any[]).filter(p => p.gpu_amount > 0).map(p => ({
      id: p.name, name: p.name, gpu: gpuShort(p.gpu_model), gpus: p.gpu_amount, vcpus: p.core_number, ramGb: Math.round(p.memory_amount / 1024), price: priceOf(firstZone, p.name), currency: cur,
      regions: [...gpuZones].filter(z => av[z] && av[z].gpu_plans && av[z].gpu_plans[p.name] !== undefined),
      note: /-SPOT-/.test(p.name) ? 'Spot: can be shut down with 30 seconds notice' : undefined
    })).sort((a: Config, b: Config) => b.gpus - a.gpus || (a.name.includes('SPOT') ? 1 : 0) - (b.name.includes('SPOT') ? 1 : 0) || a.name.localeCompare(b.name));
    const lim = acc && acc.resource_limits;
    if (lim && typeof lim.gpus === 'number') notes.push(`Your account may run ${lim.gpus} GPU${lim.gpus === 1 ? '' : 's'} at once${lim.cores ? `, ${lim.cores} CPU cores` : ''}${lim.memory ? ` and ${Math.round(lim.memory / 1024)} GB of memory` : ''}. A bigger plan is refused until UpCloud support raises the limit.`);
    if (acc && typeof acc.credits === 'number') notes.push(`Credits: ${Math.round(acc.credits) / 100} ${cur} (as UpCloud reports it). Promotional credits cannot pay for GPU servers.`);
    notes.push('GPU servers bill by the started hour while they are on; disks and IPv4 addresses bill even when the server is off.');
    const zoneName = new Map((zones as any[]).map(z => [z.id, z.description || z.id]));
    const ai = (tpls as any[]).filter(t => /ai\/?ml|gpu/i.test(t.title || ''));
    const rest = (tpls as any[]).filter(t => !ai.includes(t) && t.template_type === 'cloud-init');
    return {configs, offers: offersOf(av), at: c.now, notes, account: (acc && acc.username) || undefined,
      regions: [...gpuZones].map(id => ({id, name: `${zoneName.get(id) || id} (${id})`})),
      options: {templates: [...ai, ...rest].map(t => ({id: t.uuid, name: t.title, detail: t.template_type}))}};
  },
  async offers(c) { return offersOf(await avail(c)); },
  async launch(c, p) {
    const s = p.spec.launch || {};
    if (!s.template) throw new ProviderError('invalid', 'Choose an operating system template.');
    const keys = String(s.ssh_keys || '').split('\n').map(x => x.trim()).filter(Boolean);
    if (!keys.length) throw new ProviderError('invalid', 'UpCloud needs at least one SSH public key for cloud-init templates.');
    const host = (s.hostname || p.name).toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'apicheck';
    const server: Record<string, unknown> = {
      zone: p.region, title: p.name, hostname: host, plan: p.config, metadata: 'yes',
      login_user: {...(s.username ? {username: s.username} : {}), create_password: 'no', ssh_keys: {ssh_key: keys}},
      storage_devices: {storage_device: [{action: 'clone', storage: s.template, title: p.name + '-os', size: s.disk_size || 200, tier: s.disk_tier || 'maxiops'}]},
      networking: {interfaces: {interface: [{type: 'public', ip_addresses: {ip_address: [{family: 'IPv4'}]}}, {type: 'utility', ip_addresses: {ip_address: [{family: 'IPv4'}]}}]}},
      labels: {label: [{key: 'managedBy', value: 'apicheck'}, {key: 'watch', value: String(p.spec.watchId || '').slice(0, 60)}]},
      firewall: 'off', password_delivery: 'none'
    };
    if (s.user_data) server.user_data = s.user_data;
    const r = await call(c, BASE + '/server', {method: 'POST', body: JSON.stringify({server}), headers: H(c), timeout: 45000}, classify);
    const sv = r && r.server;
    if (!sv || !sv.uuid) throw new ProviderError('http', 'UpCloud accepted the request but returned no server id.');
    return {extId: sv.uuid, name: sv.title || p.name, detail: {state: sv.state, zone: p.region}};
  },
  async instance(c, extId) {
    const r = await get(c, '/server/' + encodeURIComponent(extId)), sv = r && r.server;
    if (!sv) return null;
    const ips = (sv.ip_addresses && sv.ip_addresses.ip_address) || [], pub = ips.find((i: any) => i.access === 'public' && i.family === 'IPv4');
    return {status: sv.state, ip: pub ? pub.address : null, plan: sv.plan, zone: sv.zone};
  }
};
