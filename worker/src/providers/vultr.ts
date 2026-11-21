// Vultr. API: https://api.vultr.com/v2, "Authorization: Bearer <key>".
// Read 21.11.2026 from the official Go client (github.com/vultr/govultr: plan.go, region.go, bare_metal_server.go, instance.go) and vultr.com/api.
// GPU machines come two ways: bare metal plans (GET /v2/plans-metal, ids like vbm-112c-2048gb-8-h100-gpu, created with POST /v2/bare-metals)
//   and Cloud GPU plans (GET /v2/plans?type=vcg, ids like vcg-h100-216c-1914gb-640vram, created with POST /v2/instances).
// Availability: GET /v2/regions/{region}/availability lists "the plan IDs currently available" in that region (GPU plans included since
//   June 2022). A plan's own "locations" narrows which regions are asked.
// Errors: {"error": "...", "status": n}. Limits: 30 requests per second per source address, all endpoints together.
// The API key can be limited to IP addresses (Account, API, Access Control). API Check runs on Cloudflare, whose addresses change.
import {ProviderError} from '../types';
import type {Provider, Ctx, Catalog, Config, Offer, LaunchPlan, Check, Machine} from '../types';
import {call, round2, prep, gib2gb} from './net';
import type {Classify} from './net';

const BASE = 'https://api.vultr.com/v2';
const H = (c: Ctx) => ({authorization: 'Bearer ' + c.secret.trim()});
export const classify: Classify = (status, body, text) => {
  const m = String((body && body.error) || text || '');
  if (status === 401) return 'auth';
  if (status === 403) return /ip|address|access control|acl/i.test(m) ? 'auth' : 'quota';
  if (status === 429) return 'rate';
  if (status === 402) return 'money';
  if (status === 404 || status === 405 || status === 409) return 'invalid';
  if (status === 400 || status === 412 || status === 422) {
    if (/balance|funds|payment|credit card|billing|deposit/i.test(m)) return 'money';
    if (/limit|quota|maximum|exceed|not (enabled|allowed)|verif/i.test(m)) return 'quota';
    if (/stock|unavailable|not available|capacity|sold out|no (hardware|available|free)|insufficient/i.test(m)) return 'capacity';
    if (/invalid|must|required|not found|unknown|does not exist|format/i.test(m)) return 'invalid';
    return 'capacity';
  }
  return null;
};
const get = (c: Ctx, path: string, memo = false) => call(c, BASE + path, {headers: H(c), memo}, classify);
async function soft<T>(notes: string[], what: string, fn: () => Promise<T>, empty: T): Promise<T> {
  try { return await fn(); } catch (e) { notes.push(`Could not read ${what}: ${(e as Error).message}`); return empty; }
}
/* every page of a list: Vultr pages with meta.links.next, a cursor */
async function pages(c: Ctx, path: string, field: string, memo = false): Promise<any[]> {
  const out: any[] = [];
  let cursor = '';
  for (let i = 0; i < 10; i++) {
    const r = await get(c, path + (path.includes('?') ? '&' : '?') + 'per_page=500' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), memo && !cursor);
    out.push(...((r && r[field]) || []));
    cursor = (r && r.meta && r.meta.links && r.meta.links.next) || '';
    if (!cursor) break;
  }
  return out;
}
/* labels: Vultr allows most characters; keep the same shape as elsewhere */
const label = (n: string) => n.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'apicheck';
const hostname = (n: string) => n.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63) || 'apicheck';
const VRAM: Record<string, number> = {h100: 80, h200: 141, a100: 80, l40s: 48, a40: 48, a16: 16, b200: 180, b300: 288, gh200: 96, mi300x: 192, mi325x: 256, mi355x: 288};
const GPU_NAME: Record<string, string> = {h100: 'H100', h200: 'H200', a100: 'A100', l40s: 'L40S', a40: 'A40', a16: 'A16', b200: 'B200', b300: 'B300', gh200: 'GH200', mi300x: 'MI300X', mi325x: 'MI325X', mi355x: 'MI355X'};
type G = {kind: 'metal' | 'vcg'; id: string; gpu: string; gpus: number; vcpus?: number; ramGb?: number; diskGb?: number; vramGb?: number; price?: number; estimated?: boolean; locations: string[]};
/* bare metal GPU plans: the GPU count and model are in the id (vbm-112c-2048gb-8-h100-gpu); newer answers may carry gpu fields too */
export function metalOf(p: any): G | null {
  const m = String(p.id || '').match(/-(\d+)-([a-z0-9]+)-gpu$/i);
  const model = String(p.gpu_type || (m && m[2]) || '').toLowerCase().replace(/^nvidia_|^amd_/, '');
  const n = Number(p.gpu_count || (m && m[1]) || 0);
  if (!n || !model) return null;
  const hourly = Number(p.hourly_cost) || (Number(p.monthly_cost) ? Number(p.monthly_cost) / 730 : 0);
  return {kind: 'metal', id: p.id, gpu: GPU_NAME[model] || model.toUpperCase(), gpus: n, vcpus: p.cpu_threads || p.cpu_count, ramGb: p.ram ? gib2gb(p.ram / 1024) : undefined,
    diskGb: p.disk ? p.disk * (p.disk_count || 1) : undefined, vramGb: VRAM[model], price: hourly ? round2(hourly) : undefined, estimated: !Number(p.hourly_cost), locations: p.locations || []};
}
/* Cloud GPU plans: gpu_type and the total VRAM; the GPU count is the total VRAM over one card's */
export function vcgOf(p: any): G | null {
  if (!p.gpu_type && !/^vcg-/.test(String(p.id || ''))) return null;
  const model = String(p.gpu_type || (String(p.id).match(/^vcg-([a-z0-9]+)-/i) || [])[1] || '').toLowerCase().replace(/^nvidia_|^amd_/, '').replace(/_.*$/, '');
  const per = VRAM[model], total = Number(p.gpu_vram_gb) || Number((String(p.id).match(/-(\d+)vram/) || [])[1]) || 0;
  const n = per && total >= per ? Math.round(total / per) : 1;
  const hourly = Number(p.hourly_cost) || (Number(p.monthly_cost) ? Number(p.monthly_cost) / 730 : 0);
  return {kind: 'vcg', id: p.id, gpu: GPU_NAME[model] || model.toUpperCase(), gpus: n, vcpus: p.vcpu_count, ramGb: p.ram ? gib2gb(p.ram / 1024) : undefined, diskGb: p.disk || undefined,
    vramGb: per || (total || undefined), price: hourly ? round2(hourly) : undefined, estimated: !Number(p.hourly_cost), locations: p.locations || []};
}
async function gpuPlans(c: Ctx, memo = false): Promise<G[]> {
  const [metal, vcg] = await Promise.all([pages(c, '/plans-metal', 'plans_metal', memo), pages(c, '/plans?type=vcg', 'plans', memo)]);
  return [...metal.map(metalOf), ...vcg.map(vcgOf)].filter(Boolean) as G[];
}
/* the regions to ask: those the watch names, narrowed to where the plans are sold at all */
async function availability(c: Ctx, plans: G[], targets: string[], regions: string[]): Promise<Offer[]> {
  const want = targets.length ? plans.filter(p => targets.includes(p.id)) : plans;
  const sold = new Set(want.flatMap(p => p.locations));
  const ask = (regions.length ? regions.filter(r => !sold.size || sold.has(r)) : [...sold]).slice(0, 30);
  const out: Offer[] = [];
  const res = await Promise.all(ask.map(r => get(c, '/regions/' + encodeURIComponent(r) + '/availability', true).then((x: any) => [r, (x && x.available_plans) || []] as const)));
  for (const [r, avail] of res) for (const p of want) if (avail.includes(p.id)) out.push({config: p.id, region: r, level: 'yes'});
  return out;
}
const isMetal = (id: string) => /^vbm-/.test(id);
/* the operating system: the chosen one, or the newest Ubuntu LTS for x64 */
export function pickOs(list: any[], wanted?: string | number) {
  if (wanted) { const w = list.find(o => String(o.id) === String(wanted)); if (w) return w; }
  const ub = list.filter(o => /^Ubuntu \d\d\.04/i.test(o.name || '') && /x64/i.test(o.name || o.arch || '') && !/desktop/i.test(o.name || ''));
  return ub.sort((a, b) => String(b.name).localeCompare(String(a.name), undefined, {numeric: true}))[0] || null;
}
const b64 = (s: string) => btoa(unescape(encodeURIComponent(s)));
async function machines(c: Ctx): Promise<Machine[]> {
  const [bm, vm] = await Promise.all([pages(c, '/bare-metals', 'bare_metals'), pages(c, '/instances', 'instances')]);
  return [...bm, ...vm].map((x: any): Machine => ({extId: String(x.id), name: x.label || '', config: x.plan || '', region: x.region || '', status: String(x.status || '') + (x.power_status && x.power_status !== 'running' ? ' (' + x.power_status + ')' : '')}));
}

export const vultr: Provider = {
  id: 'vultr',
  async validate(c) {
    const r = await get(c, '/account'), a = (r && r.account) || {};
    return {meta: {balance: a.balance, pending: a.pending_charges}, account: a.email || a.name || undefined};
  },
  async catalog(c): Promise<Catalog> {
    const notes: string[] = [];
    const plans = await gpuPlans(c, true);
    const [regions, keys, os, acct, offers] = await Promise.all([
      soft(notes, 'regions', () => pages(c, '/regions', 'regions'), [] as any[]),
      soft(notes, 'SSH keys', () => pages(c, '/ssh-keys', 'ssh_keys'), [] as any[]),
      soft(notes, 'operating systems', () => pages(c, '/os', 'os'), [] as any[]),
      soft(notes, 'the account', () => get(c, '/account').then((r: any) => (r && r.account) || null), null as any),
      soft(notes, 'availability by region', () => availability(c, plans, [], []), [] as Offer[])
    ]);
    const configs: Config[] = plans.map(p => ({id: p.id, name: `${p.gpus}x ${p.gpu} ${p.kind === 'metal' ? 'bare metal' : 'Cloud GPU'}`, gpu: p.gpu, gpus: p.gpus, vcpus: p.vcpus, ramGb: p.ramGb, diskGb: p.diskGb, vramGb: p.vramGb,
      price: p.price, currency: 'USD', regions: p.locations, note: p.price && p.estimated ? 'Price: the monthly price over 730 hours (Vultr gave no hourly one)' : undefined}));
    if (!keys.length) notes.push('There is no SSH key on the account (Account, SSH Keys). Without one the machine gets a root password shown in the Vultr console.');
    if (acct && acct.balance != null) notes.push(`Balance: ${Number(acct.balance) < 0 ? '$' + round2(-Number(acct.balance)) + ' in credit' : '$' + round2(Number(acct.balance)) + ' owed'}, pending charges $${round2(Number(acct.pending_charges || 0))}.`);
    notes.push('The Vultr API key answers only from the addresses allowed under Account, API, Access Control. API Check runs on Cloudflare, whose addresses change, so the list must allow any IPv4 and IPv6.');
    notes.push('Vultr bills by the hour up to a monthly cap while the machine exists, on or off. Bare metal takes several minutes to install.');
    const name = new Map<string, string>(regions.map((r: any) => [r.id, `${r.city}, ${r.country}`]));
    const used = [...new Set(plans.flatMap(p => p.locations))].sort();
    return {configs: configs.sort((a, b) => b.gpus - a.gpus || (b.price || 0) - (a.price || 0)), offers, at: c.now, notes, account: acct ? acct.email : undefined,
      regions: used.map(id => ({id, name: name.get(id) ? `${name.get(id)} (${id})` : id})),
      options: {
        sshKeys: keys.map((k: any) => ({id: String(k.id), name: k.name})),
        os: pickOs(os) ? os.filter((o: any) => /x64/i.test(o.arch || o.name || '') && !/windows/i.test(o.family || o.name || '')).map((o: any) => ({id: String(o.id), name: o.name})) : []
      }};
  },
  async offers(c, w) {
    const s = w.spec || {};
    return availability(c, await gpuPlans(c, true), s.configs || [], s.regions || []);
  },
  async launch(c, p: LaunchPlan) {
    const s = p.spec.launch || {}, name = label(p.name);
    const [os, keys] = await prep(Promise.all([pages(c, '/os', 'os'), pages(c, '/ssh-keys', 'ssh_keys')]));
    const o = pickOs(os, s.os);
    if (!o) throw new ProviderError('invalid', 'No Ubuntu image found at Vultr. Choose an operating system in the launch settings.', 1);
    const key = s.ssh_key ? keys.filter((k: any) => String(k.id) === String(s.ssh_key)) : keys;
    if (s.ssh_key && !key.length) throw new ProviderError('invalid', 'The chosen SSH key is no longer on the Vultr account.', 1);
    const body: Record<string, unknown> = {region: p.region, plan: p.config, os_id: o.id, label: name, hostname: hostname(s.hostname || name), sshkey_id: key.map((k: any) => String(k.id)), tags: ['apicheck'], enable_ipv6: false};
    if (s.user_data) body.user_data = b64(s.user_data);
    const metal = isMetal(p.config);
    if (metal) body.activation_email = false; else body.backups = 'disabled';
    const r = await call(c, BASE + (metal ? '/bare-metals' : '/instances'), {method: 'POST', body: JSON.stringify(body), headers: H(c), timeout: 45000}, classify);
    const m = r && (r.bare_metal || r.instance);
    if (!m || !m.id) throw new ProviderError('http', 'Vultr accepted the request but returned no machine id.');
    return {extId: String(m.id), name, detail: {status: m.status, region: p.region, os: o.name, keys: key.map((k: any) => k.name), kind: metal ? 'bare metal' : 'Cloud GPU'}};
  },
  async find(c, p) {
    const name = label(p.name);
    const m = (await machines(c)).find(x => x.name === name);
    return m ? {extId: m.extId, status: m.status} : null;
  },
  async active(c) {
    return machines(c);
  },
  async preflight(c, spec) {
    const out: Check[] = [], s = spec.launch || {};
    const [os, keys, plans, acct] = await Promise.all([pages(c, '/os', 'os'), pages(c, '/ssh-keys', 'ssh_keys'), gpuPlans(c), get(c, '/account').then((r: any) => (r && r.account) || {})]);
    const o = pickOs(os, s.os);
    out.push(o ? {level: 'ok', text: `Operating system: ${o.name}.`} : {level: 'fail', text: 'No Ubuntu image found; choose an operating system.'});
    const key = s.ssh_key ? keys.filter((k: any) => String(k.id) === String(s.ssh_key)) : keys;
    out.push(key.length ? {level: 'ok', text: `SSH key${key.length === 1 ? '' : 's'}: ${key.map((k: any) => k.name).join(', ')}.`} : {level: s.ssh_key ? 'fail' : 'warn', text: s.ssh_key ? 'The chosen SSH key is no longer on the account.' : 'No SSH key on the account: the machine gets a root password instead.'});
    for (const cfg of spec.configs || []) {
      const pl = plans.find(x => x.id === cfg);
      if (!pl) { out.push({level: 'fail', text: `${cfg}: Vultr no longer lists this plan.`}); continue; }
      const regs: string[] = spec.regions && spec.regions.length ? spec.regions : pl.locations;
      const off = regs.filter(r => pl.locations.length && !pl.locations.includes(r));
      out.push(off.length ? {level: 'warn', text: `${cfg}: not sold in ${off.join(', ')}.`} : {level: 'ok', text: `${cfg}: sold in ${pl.locations.join(', ') || 'no region right now'}${pl.price ? `, about $${pl.price} an hour` : ''}.`});
    }
    if (acct.balance != null) {
      const credit = -Number(acct.balance) - Number(acct.pending_charges || 0);
      out.push({level: credit > 0 ? 'ok' : 'warn', text: `Credit left after pending charges: $${round2(credit)}. Vultr also needs a payment method on file for GPU machines.`});
    }
    return out;
  },
  async instance(c, extId) {
    let x: any = await get(c, '/bare-metals/' + encodeURIComponent(extId)).catch(() => null);
    let m = x && x.bare_metal;
    if (!m) { x = await get(c, '/instances/' + encodeURIComponent(extId)); m = x && x.instance; }
    if (!m) return null;
    return {status: m.status, power: m.power_status, ip: m.main_ip || null, plan: m.plan, region: m.region, os: m.os};
  }
};
