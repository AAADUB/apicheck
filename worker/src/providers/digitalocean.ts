// DigitalOcean GPU Droplets. API: https://api.digitalocean.com/v2, "Authorization: Bearer <token>".
// Read 21.11.2026 from the official OpenAPI description (github.com/digitalocean/openapi, specification/resources/{sizes,regions,droplets,account}).
// Availability: GET /v2/sizes gives every size with "available" and "regions": the region slugs "where this size is available for Droplet creates".
//   Whether a region leaves that list the moment its GPUs run out is not documented, so the launch itself is the final word.
// Launch: POST /v2/droplets {name, region, size, image, ssh_keys, tags, user_data}. 202 Accepted does not mean success: the create action can
//   still end "errored", so the action is followed for a while and an errored Droplet is destroyed.
// GPU Droplets are left out of GET /v2/droplets unless ?type=gpus is given.
// Images: gpu-h100x8-base for 8-GPU Droplets, gpu-h100x1-base for single-GPU ones (docs.digitalocean.com, Recommended GPU setup).
// Limits: 5000 requests per hour and 250 per minute per token (ratelimit-* headers).
import {ProviderError} from '../types';
import type {Provider, Ctx, Catalog, Config, Offer, LaunchPlan, Check, Machine} from '../types';
import {call, round2, prep, gib2gb} from './net';
import type {Classify} from './net';

const BASE = 'https://api.digitalocean.com/v2';
const H = (c: Ctx) => ({authorization: 'Bearer ' + c.secret.trim()});
export const classify: Classify = (status, body, text) => {
  const m = String((body && (body.message || body.id)) || text || '');
  if (status === 401) return 'auth';
  if (status === 403) return /scope|permission|forbidden/i.test(m) ? 'invalid' : 'quota';
  if (status === 429) return 'rate';
  if (status === 402) return 'money';
  if (status === 404 || status === 405 || status === 409) return 'invalid';
  if (status === 400 || status === 422) {
    if (/balance|payment|billing|credit card|past due|unpaid/i.test(m)) return 'money';
    if (/droplet limit|limit|quota|exceed|not (enabled|allowed|permitted)|request access|verify/i.test(m)) return 'quota';
    if (/not available|unavailable|capacity|sold out|out of stock|insufficient|no (available|free)/i.test(m)) return 'capacity';
    if (/image|ssh|key|name|tag|user.?data|vpc|invalid|must|required|not found|does not exist|format/i.test(m)) return 'invalid';
    return 'capacity';
  }
  return null;
};
const get = (c: Ctx, path: string, memo = false) => call(c, path.startsWith('http') ? path : BASE + path, {headers: H(c), memo}, classify);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/* Droplet names: letters, digits, dots and dashes */
const dropletName = (n: string) => n.replace(/[^A-Za-z0-9.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 63) || 'apicheck';
async function soft<T>(notes: string[], what: string, fn: () => Promise<T>, empty: T): Promise<T> {
  try { return await fn(); } catch (e) { notes.push(`Could not read ${what}: ${(e as Error).message}`); return empty; }
}
/* every page of a list: DigitalOcean links to the next page in links.pages.next */
async function pages(c: Ctx, path: string, field: string): Promise<any[]> {
  const out: any[] = [];
  let url: string | null = BASE + path + (path.includes('?') ? '&' : '?') + 'per_page=200';
  for (let i = 0; url && i < 10; i++) {
    const r = await get(c, url);
    out.push(...((r && r[field]) || []));
    url = (r && r.links && r.links.pages && r.links.pages.next) || null;
  }
  return out;
}
const GPU_NAME: Record<string, string> = {nvidia_h100: 'H100 SXM', nvidia_h200: 'H200 SXM', nvidia_l40s: 'L40S', nvidia_rtx_4000_ada: 'RTX 4000 Ada', nvidia_rtx_6000_ada: 'RTX 6000 Ada', nvidia_b300: 'B300', amd_mi300x: 'MI300X', amd_mi325x: 'MI325X', amd_mi350x: 'MI350X', amd_mi355x: 'MI355X'};
const gpuName = (m: string) => GPU_NAME[m] || String(m || 'GPU').replace(/^(nvidia|amd)_/, '').replace(/_/g, ' ').toUpperCase();
const isGpu = (s: any) => !!(s && s.gpu_info && s.gpu_info.count);
/* the base image DigitalOcean recommends for the size */
export const imageFor = (size: any, wanted?: string) => wanted || (size && /^amd_/.test(String(size.gpu_info && size.gpu_info.model)) ? 'gpu-amd-base' : (size && size.gpu_info && size.gpu_info.count > 1 ? 'gpu-h100x8-base' : 'gpu-h100x1-base'));
function offersOf(sizes: any[]): Offer[] {
  const out: Offer[] = [];
  for (const s of sizes) if (isGpu(s) && s.available !== false) for (const r of s.regions || []) out.push({config: s.slug, region: r, level: 'yes'});
  return out;
}
async function sizes(c: Ctx, memo = false): Promise<any[]> {
  const r = await get(c, '/sizes?per_page=200', memo);
  return ((r && r.sizes) || []).filter(isGpu);
}
const gpuDroplets = (c: Ctx) => pages(c, '/droplets?type=gpus', 'droplets');
/* the SSH keys a launch puts on the Droplet: the chosen one, or every key on the team */
async function keysFor(c: Ctx, wanted?: string) {
  const keys = await pages(c, '/account/keys', 'ssh_keys');
  if (wanted) { const k = keys.find((x: any) => String(x.id) === String(wanted) || x.fingerprint === wanted); return k ? [k] : []; }
  return keys;
}

export const digitalocean: Provider = {
  id: 'digitalocean',
  async validate(c) {
    const r = await get(c, '/account'), a = (r && r.account) || {};
    const meta: Record<string, any> = {dropletLimit: a.droplet_limit, status: a.status, team: a.team && a.team.name};
    return {meta, account: a.email || (a.team && a.team.name) || undefined};
  },
  async catalog(c): Promise<Catalog> {
    const notes: string[] = [];
    const [sz, regions, keys, acct, bal] = await Promise.all([
      sizes(c, true),
      soft(notes, 'regions', () => pages(c, '/regions', 'regions'), [] as any[]),
      soft(notes, 'SSH keys', () => pages(c, '/account/keys', 'ssh_keys'), [] as any[]),
      soft(notes, 'the account', () => get(c, '/account').then((r: any) => (r && r.account) || null), null as any),
      soft(notes, 'the balance', () => get(c, '/customers/my/balance'), null as any)
    ]);
    const configs: Config[] = sz.map((s: any) => ({id: s.slug, name: `${s.gpu_info.count}x ${gpuName(s.gpu_info.model)}`, gpu: gpuName(s.gpu_info.model), gpus: s.gpu_info.count,
      vcpus: s.vcpus, ramGb: s.memory ? gib2gb(s.memory / 1024) : undefined, diskGb: s.disk || undefined, vramGb: s.gpu_info.vram && s.gpu_info.vram.amount || undefined,
      price: s.price_hourly ? round2(s.price_hourly) : undefined, currency: 'USD', regions: s.regions || [], note: s.description || undefined}));
    if (!keys.length) notes.push('There is no SSH key on this team. Add one (Settings, Security) or the Droplet will only be reachable with a root password sent by email.');
    if (acct && acct.status && acct.status !== 'active') notes.push(`DigitalOcean marks the account "${acct.status}"${acct.status_message ? ': ' + acct.status_message : ''}. A locked or warned account cannot create Droplets.`);
    if (acct && acct.droplet_limit != null) notes.push(`Droplet limit: ${acct.droplet_limit} at a time.`);
    if (bal && bal.month_to_date_balance != null) notes.push(`Balance this month: $${round2(Number(bal.month_to_date_balance))} (account balance $${round2(Number(bal.account_balance || 0))}).`);
    notes.push('A GPU Droplet bills by the second from creation until it is destroyed, powered off or not (minimum 5 minutes). Newer accounts may be charged part way through the month when a GPU Droplet is created.');
    const name = new Map<string, string>(regions.map((r: any) => [r.slug, r.name]));
    const used = [...new Set(sz.flatMap((s: any) => s.regions || []))].sort();
    return {configs: configs.sort((a, b) => b.gpus - a.gpus || (b.price || 0) - (a.price || 0)), offers: offersOf(sz), at: c.now, notes,
      account: acct ? acct.email : undefined,
      regions: used.map(id => ({id, name: name.get(id) ? `${name.get(id)} (${id})` : id})),
      options: {sshKeys: keys.map((k: any) => ({id: String(k.id), name: k.name || k.fingerprint, detail: k.fingerprint}))}};
  },
  async offers(c) {
    return offersOf(await sizes(c, true));
  },
  async launch(c, p: LaunchPlan) {
    const s = p.spec.launch || {}, name = dropletName(p.name);
    const [sz, keys] = await prep(Promise.all([sizes(c), keysFor(c, s.ssh_key)]));
    const size = sz.find((x: any) => x.slug === p.config);
    if (s.ssh_key && !keys.length) throw new ProviderError('invalid', 'The chosen SSH key is no longer on the DigitalOcean team.', 1);
    const body: Record<string, unknown> = {name, region: p.region, size: p.config, image: imageFor(size, s.image), ssh_keys: keys.map((k: any) => k.id), tags: ['apicheck'],
      monitoring: false, ipv6: false};
    if (s.user_data) body.user_data = s.user_data;
    const r = await call(c, BASE + '/droplets', {method: 'POST', body: JSON.stringify(body), headers: H(c), timeout: 45000}, classify);
    const d = r && r.droplet;
    if (!d || d.id == null) throw new ProviderError('http', 'DigitalOcean accepted the request but returned no Droplet id.');
    const id = String(d.id);
    const act = r.links && Array.isArray(r.links.actions) && r.links.actions[0];
    // follow the create action for a minute: an errored create is destroyed and counts as no capacity; a slow one is left to finish
    let status = 'in-progress';
    for (let i = 0; i < 13; i++) {
      if (i) await sleep(5000);
      const a = act && act.id != null ? await get(c, '/actions/' + act.id).catch(() => null) : null;
      if (a && a.action && a.action.status) status = String(a.action.status);
      else { const x = await get(c, '/droplets/' + id).catch(() => null); if (x && x.droplet && x.droplet.status === 'active') status = 'completed'; }
      if (status !== 'in-progress') break;
    }
    if (status === 'errored') {
      await call(c, BASE + '/droplets/' + id, {method: 'DELETE', headers: H(c)}, classify).catch(() => null);
      throw new ProviderError('capacity', 'DigitalOcean accepted the Droplet but the create action ended "errored" (most likely no free GPU host); it was destroyed.');
    }
    return {extId: id, name, price: size && size.price_hourly ? round2(size.price_hourly) : undefined, currency: 'USD', detail: {status: d.status, action: status, region: p.region, image: body.image, keys: keys.map((k: any) => k.name)}};
  },
  async find(c, p) {
    const name = dropletName(p.name);
    const d = (await gpuDroplets(c)).find((x: any) => x && String(x.name).toLowerCase() === name.toLowerCase());
    return d && d.status !== 'archive' ? {extId: String(d.id), status: d.status} : null;
  },
  async active(c) {
    return (await gpuDroplets(c)).filter((d: any) => d && d.status !== 'archive').map((d: any): Machine => ({extId: String(d.id), name: d.name || '', config: d.size_slug || (d.size && d.size.slug) || '', region: (d.region && d.region.slug) || '', status: String(d.status || '')}));
  },
  async preflight(c, spec) {
    const out: Check[] = [], s = spec.launch || {};
    const [sz, acct] = await Promise.all([sizes(c), get(c, '/account').then((r: any) => (r && r.account) || {})]);
    if (acct.status && acct.status !== 'active') out.push({level: 'fail', text: `DigitalOcean marks the account "${acct.status}"${acct.status_message ? ': ' + acct.status_message : ''}.`});
    if (acct.email_verified === false) out.push({level: 'fail', text: 'The account e-mail is not verified; DigitalOcean will not create Droplets.'});
    const keys = await keysFor(c, s.ssh_key);
    out.push(keys.length ? {level: 'ok', text: `SSH key${keys.length === 1 ? '' : 's'}: ${keys.map((k: any) => k.name).join(', ')}.`} : {level: s.ssh_key ? 'fail' : 'warn', text: s.ssh_key ? 'The chosen SSH key is no longer on the team.' : 'No SSH key on the team: the Droplet gets a root password by e-mail instead.'});
    for (const cfg of spec.configs || []) {
      const size = sz.find((x: any) => x.slug === cfg);
      if (!size) { out.push({level: 'fail', text: `${cfg}: DigitalOcean no longer lists this size.`}); continue; }
      const img = imageFor(size, s.image);
      const im = await get(c, '/images/' + encodeURIComponent(img)).catch(() => null);
      out.push(im && im.image ? {level: 'ok', text: `${cfg}: image ${img} (${im.image.name}).`} : {level: 'fail', text: `${cfg}: the image ${img} was not found.`});
      const regs: string[] = spec.regions && spec.regions.length ? spec.regions : [];
      const off = regs.filter(r => !(size.regions || []).includes(r));
      if (off.length) out.push({level: 'warn', text: `${cfg}: DigitalOcean does not list it in ${off.join(', ')} right now.`});
    }
    if (acct.droplet_limit != null) {
      const all = await pages(c, '/droplets', 'droplets').catch(() => null), gpu = await gpuDroplets(c).catch(() => null);
      if (all && gpu) { const n = all.length + gpu.length; out.push(n >= acct.droplet_limit ? {level: 'fail', text: `The account runs ${n} Droplets and may run ${acct.droplet_limit}.`} : {level: 'ok', text: `Droplets: ${n} of ${acct.droplet_limit} allowed.`}); }
    }
    try { const b = await get(c, '/customers/my/balance'); if (b && b.account_balance != null) out.push({level: 'ok', text: `Account balance $${round2(Number(b.account_balance))}, this month so far $${round2(Number(b.month_to_date_balance || 0))}.`}); } catch { /* needs the billing scope */ }
    return out;
  },
  async instance(c, extId) {
    const x = await get(c, '/droplets/' + encodeURIComponent(extId)), d = x && x.droplet;
    if (!d) return null;
    const v4 = ((d.networks && d.networks.v4) || []);
    return {status: d.status, ip: (v4.find((n: any) => n.type === 'public') || {}).ip_address || null, privateIp: (v4.find((n: any) => n.type === 'private') || {}).ip_address || null, size: d.size_slug, region: d.region && d.region.slug};
  }
};
