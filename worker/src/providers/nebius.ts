// Nebius AI Cloud over REST (https://api.nebius.cloud, one host for all regions). Read 20.11.2026 from docs.nebius.com, github.com/nebius/api protos and the SDKs.
// Credentials: a service account's authorized key (the CLI's credentials file). A short JWT signed with it is exchanged for a 12-hour access token.
// Availability: the capacity advisor, GET /capacity/v1/resource-advice?parentId=<tenant>: a launch chance per region, platform and preset, clipped by your quota.
// Launch: POST /compute/v1/instances returns an operation; a placement failure says "Not enough resources", either on the call or on the operation.
import {ProviderError} from '../types';
import type {Provider, Ctx, Catalog, Config, Offer, Level, Check, Machine} from '../types';
import {call, messageOf, Unclear, prep} from './net';
import type {Classify} from './net';

const API = 'https://api.nebius.cloud', AUTH = 'https://auth.eu.nebius.com:443/oauth2/token/exchange';
const enc = new TextEncoder();
const b64u = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b instanceof Uint8Array ? b : new Uint8Array(b)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
type Creds = {kid: string; iss: string; sub: string; key: string};

/* the credentials file, or the same three values written out by hand */
export function readCreds(secret: string): Creds {
  let j: any; try { j = JSON.parse(secret); } catch { throw new ProviderError('auth', 'The credentials are not valid JSON.'); }
  const s = j['subject-credentials'] || j.subjectCredentials || j;
  const out = {kid: s.kid || s['public-key-id'] || s.publicKeyId, iss: s.iss || s['service-account-id'] || s.serviceAccountId, sub: s.sub || s.iss || s['service-account-id'] || s.serviceAccountId, key: s['private-key'] || s.privateKey};
  if (!out.kid || !out.iss || !out.key) throw new ProviderError('auth', 'The credentials need kid (the public key id), iss (the service account id) and private-key.');
  if (/BEGIN RSA PRIVATE KEY/.test(out.key)) throw new ProviderError('auth', 'This private key is in the old PKCS#1 form. Convert it with: openssl pkcs8 -topk8 -nocrypt -in key.pem -out key-pkcs8.pem');
  return out;
}
const tokens = new Map<string, {token: string; until: number}>();
async function token(c: Ctx): Promise<string> {
  const cr = readCreds(c.secret), hit = tokens.get(cr.kid);
  if (hit && hit.until > Date.now() + 5 * 60e3) return hit.token;
  let key: CryptoKey;
  try { key = await crypto.subtle.importKey('pkcs8', Uint8Array.from(atob(cr.key.replace(/-----[^-]+-----|\s/g, '')), ch => ch.charCodeAt(0)), {name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256'}, false, ['sign']); }
  catch { throw new ProviderError('auth', 'The private key could not be read. Paste the whole credentials file the Nebius CLI wrote.'); }
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(enc.encode(JSON.stringify({alg: 'RS256', typ: 'JWT', kid: cr.kid}))), body = b64u(enc.encode(JSON.stringify({iss: cr.iss, sub: cr.sub, aud: 'token-service.iam.new.nebiuscloud.net', iat: now, exp: now + 60})));
  const jwt = head + '.' + body + '.' + b64u(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(head + '.' + body)));
  const form = new URLSearchParams({grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange', requested_token_type: 'urn:ietf:params:oauth:token-type:access_token', subject_token: jwt, subject_token_type: 'urn:ietf:params:oauth:token-type:jwt'});
  const r = await call(c, AUTH, {method: 'POST', body: form, headers: {'content-type': 'application/x-www-form-urlencoded'}}, s => (s === 400 || s === 401 || s === 403 ? 'auth' : null));
  if (!r || !r.access_token) throw new ProviderError('auth', 'Nebius did not return an access token.');
  tokens.set(cr.kid, {token: r.access_token, until: Date.now() + (Number(r.expires_in) || 3600) * 1000});
  return r.access_token;
}
const NER = /not enough resources/i;
const classify: Classify = (status, body, text) => {
  const code = body && typeof body.code === 'number' ? body.code : 0, msg = (body && body.message) || text || '';
  const details = JSON.stringify((body && body.details) || '');
  if (NER.test(msg) || /notEnoughResources/.test(details)) return 'capacity';
  if (status === 401 || code === 16) return 'auth';
  if (status === 403 || code === 7) return 'auth';
  if (/tooManyRequests/.test(details)) return 'rate';
  if (/quotaFailure/.test(details)) return 'quota';
  if (code === 8) return 'capacity';   // RESOURCE_EXHAUSTED with no quota failure in it: no room right now (the docs give no code for "Not enough resources")
  if (status === 429) return 'rate';
  if (code === 14 || code === 13 || code === 4 || code === 10 || status >= 500) return 'http';   // 10 ABORTED: a conflict, worth another try
  return 'invalid';
};
async function api(c: Ctx, path: string, init: RequestInit & {memo?: boolean} = {}): Promise<any> {
  const t = await token(c);
  return call(c, API + path, {...init, headers: {authorization: 'Bearer ' + t, ...(init.headers as any || {})}}, classify);
}
async function list(c: Ctx, path: string, memo = false): Promise<any[]> {
  const out: any[] = []; let page = '';
  for (let i = 0; i < 10; i++) {
    const r = await api(c, path + (path.includes('?') ? '&' : '?') + 'pageSize=100' + (page ? '&pageToken=' + encodeURIComponent(page) : ''), {memo});
    out.push(...((r && r.items) || []));
    page = r && r.nextPageToken; if (!page) break;
  }
  return out;
}
const LV: Record<string, Level> = {AVAILABILITY_LEVEL_HIGH: 'high', AVAILABILITY_LEVEL_MEDIUM: 'medium', AVAILABILITY_LEVEL_LOW: 'low'};
const kindOf = (c: Ctx, spec?: any) => ((spec && spec.params && spec.params.kind) || ((c as any).params || {}).kind) === 'preemptible' ? 'preemptible' : 'onDemand';
const regionOf = (x: any) => (x && ((x.spec && x.spec.region) || (x.status && x.status.region))) || '';
/* discovery: the tenant and one project per region */
async function discover(c: Ctx) {
  const tenants = await list(c, '/iam/v1/tenants');
  if (!tenants.length) throw new ProviderError('auth', 'The service account sees no tenant. Give it a role in your tenant (viewer at least, editor to launch).');
  const tenant = tenants[0].metadata.id, projects: Record<string, string> = {};
  for (const p of await list(c, '/iam/v1/projects?parentId=' + encodeURIComponent(tenant))) { const r = regionOf(p); if (r && !projects[r]) projects[r] = p.metadata.id; }
  return {tenant, projects, account: readCreds(c.secret).iss};
}
async function advice(c: Ctx, tenant: string, kind: string): Promise<{offers: Offer[]; items: any[]}> {
  const items = await list(c, '/capacity/v1/resource-advice?parentId=' + encodeURIComponent(tenant), true), best = new Map<string, Offer>();
  for (const it of items) {
    const ci = it.spec && it.spec.computeInstance; if (!ci || !ci.preset) continue;
    const st = it.status && it.status[kind]; if (!st) continue;
    const lv = LV[st.availabilityLevel] || 'none', id = ci.platform + '|' + ci.preset.name, k = id + '|' + it.spec.region;
    if (lv === 'none') continue;
    const o: Offer = {config: id, region: it.spec.region, level: lv, note: `${st.available ?? '?'} launchable${st.dataState === 'DATA_STATE_STALE' ? ', data not fresh' : ''}${st.effectiveAt ? ', measured ' + String(st.effectiveAt).slice(11, 19) + ' UTC' : ''}`};
    const old = best.get(k); if (!old || ['low', 'medium', 'high'].indexOf(lv) > ['low', 'medium', 'high'].indexOf(old.level)) best.set(k, o);
  }
  return {offers: [...best.values()], items};
}
/* delete a failed machine, a few times if Nebius is still busy with it (one operation per resource at a time) */
async function remove(c: Ctx, id: string) {
  for (let i = 0; i < 4; i++) {
    try { await api(c, '/compute/v1/instances/' + encodeURIComponent(id), {method: 'DELETE'}); return; }
    catch (e) { if (e instanceof ProviderError && e.status === 404) return; await sleep(3000); }
  }
}
/* the first subnet of a project, kept for ten minutes so a launch is a single request */
const subnets = new Map<string, {id: string; at: number}>();
async function firstSubnet(c: Ctx, project: string): Promise<string> {
  const hit = subnets.get(project);
  if (hit && Date.now() - hit.at < 10 * 60e3) return hit.id;
  const xs = await list(c, '/vpc/v1/subnets?parentId=' + encodeURIComponent(project), true), id = (xs[0] && xs[0].metadata.id) || '';
  if (id) subnets.set(project, {id, at: Date.now()});
  return id;
}
const PRICE: Record<string, number> = {'gpu-h100-sxm': 4.5, 'gpu-h200-sxm': 5.4, 'gpu-b200-sxm': 8.5, 'gpu-b200-sxm-a': 8.5, 'gpu-b300-sxm': 9.5};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/* Nebius names: lower case letters, digits and dashes */
const vmName = (n: string) => n.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'apicheck';

export const nebius: Provider = {
  id: 'nebius',
  async validate(c) { const d = await discover(c); return {meta: d, account: d.account}; },
  async catalog(c): Promise<Catalog> {
    const notes: string[] = [], meta = c.meta && c.meta.tenant ? c.meta : await discover(c), kind = kindOf(c);
    const {offers, items} = await advice(c, meta.tenant, kind);
    const cfg = new Map<string, Config>(), regs = new Set<string>(Object.keys(meta.projects || {}));
    for (const it of items) {
      const ci = it.spec && it.spec.computeInstance; if (!ci || !ci.preset) continue;
      const id = ci.platform + '|' + ci.preset.name, r = ci.preset.resources || {}, g = r.gpuCount || 0;
      regs.add(it.spec.region);
      const x = cfg.get(id) || {id, name: `${ci.platform} · ${ci.preset.name}`, gpu: ci.platform.replace(/^gpu-/, '').replace(/-sxm.*/, '').toUpperCase() + (/sxm/.test(ci.platform) ? ' SXM' : ''), gpus: g,
        vcpus: r.vcpuCount, ramGb: r.memoryGibibytes ? Math.round(r.memoryGibibytes * 1.073741824) : undefined, vramGb: ci.gpuMemoryGigabytes, regions: [] as string[],
        price: kind === 'onDemand' && PRICE[ci.platform] && g ? Math.round(PRICE[ci.platform] * g * 100) / 100 : undefined, currency: 'USD',
        note: kind === 'onDemand' && PRICE[ci.platform] ? 'Price from the Nebius price list (per GPU-hour, read 20.11.2026), not from the API' : undefined} as Config;
      if (!x.regions!.includes(it.spec.region)) x.regions!.push(it.spec.region);
      cfg.set(id, x);
    }
    const projects = meta.projects || {};
    const [subnets, fss] = await Promise.all([
      Promise.all(Object.entries<string>(projects).map(([region, pid]) => list(c, '/vpc/v1/subnets?parentId=' + encodeURIComponent(pid)).then(xs => xs.map(s => ({id: s.metadata.id, name: `${s.metadata.name} (${region})`, region})), e => { notes.push(`Could not read subnets in ${region}: ${(e as Error).message}`); return []; }))).then(a => a.flat()),
      Promise.all(Object.entries<string>(projects).map(([region, pid]) => list(c, '/compute/v1/filesystems?parentId=' + encodeURIComponent(pid)).then(xs => xs.map(f => ({id: f.metadata.id, name: `${f.metadata.name} (${Math.round((Number(f.spec && f.spec.sizeGibibytes) || 0))} GiB, ${region})`, region})), () => []))).then(a => a.flat())
    ]);
    if (!Object.keys(projects).length) notes.push('No project was found for the service account. Launching needs the editor role in the project of each region.');
    notes.push('The launch chance is a forecast that already takes your quota into account: "Limit reached" never shows as available. New accounts get 32 H100 in eu-north1 by default; B200 starts at 0.');
    if (kind === 'preemptible') notes.push('Preemptible machines follow the spot price and can be stopped with 60 seconds notice.');
    return {configs: [...cfg.values()].sort((a, b) => b.gpus - a.gpus || a.id.localeCompare(b.id)), offers, at: c.now, notes, account: meta.account,
      regions: [...regs].sort().map(id => ({id, name: id})),
      options: {subnets, filesystems: fss, images: [{id: 'ubuntu24.04-cuda13.0', name: 'Ubuntu 24.04, CUDA 13.0'}, {id: 'ubuntu24.04-cuda12', name: 'Ubuntu 24.04, CUDA 12.8'}, {id: 'ubuntu24.04-cuda13-latest', name: 'Ubuntu 24.04, latest CUDA 13'}]}};
  },
  async offers(c, w) {
    const tenant = c.meta && c.meta.tenant;
    if (!tenant) throw new ProviderError('auth', 'The key has no tenant on record. Check the key again on the Keys page.');
    return (await advice(c, tenant, kindOf(c, w.spec))).offers;
  },
  async launch(c, p) {
    const s = p.spec.launch || {}, [platform, preset] = p.config.split('|');
    const project = c.meta && c.meta.projects && c.meta.projects[p.region];
    if (!project) throw new ProviderError('invalid', `No project for region ${p.region}. Give the service account access to that region's project and check the key again.`);
    let subnet = s.subnet && (s.subnet_region ? s.subnet_region === p.region : true) ? s.subnet : '';
    await prep(token(c));   // a token problem must not look like an unclear launch
    if (!subnet) subnet = await prep(firstSubnet(c, project));
    if (!subnet) throw new ProviderError('invalid', `No subnet in ${p.region}.`);
    const name = vmName(p.name);
    const keys = String(s.ssh_keys || '').split('\n').map(x => x.trim()).filter(Boolean), user = s.username || 'ubuntu';
    let cloud = s.user_data || '';
    if (!cloud) {
      cloud = '#cloud-config\nusers:\n  - name: ' + user + '\n    sudo: ALL=(ALL) NOPASSWD:ALL\n    shell: /bin/bash\n    ssh_authorized_keys:\n' + keys.map(k => '      - ' + JSON.stringify(k)).join('\n') + '\n';
      if (s.filesystem) cloud += 'runcmd:\n  - mkdir -p /mnt/data\n  - mount -t virtiofs data /mnt/data\n  - echo "data /mnt/data virtiofs rw,nofail 0 0" >> /etc/fstab\n';
    }
    const spec: Record<string, unknown> = {
      resources: {platform, preset},
      bootDisk: {attachMode: 'READ_WRITE', managedDisk: {name: name + '-boot', spec: {type: 'NETWORK_SSD', sizeGibibytes: String(s.disk_size || 200), sourceImageFamily: {imageFamily: s.image || 'ubuntu24.04-cuda13.0'}}}, deviceId: 'boot'},
      networkInterfaces: [{name: 'eth0', subnetId: subnet, ipAddress: {}, ...(s.public_ip === false ? {} : {publicIpAddress: {}})}],
      cloudInitUserData: cloud
    };
    if (s.filesystem && (!s.filesystem_region || s.filesystem_region === p.region)) spec.filesystems = [{attachMode: 'READ_WRITE', mountTag: 'data', existingFilesystem: {id: s.filesystem}}];
    if (kindOf(c, p.spec) === 'preemptible') { spec.preemptible = {onPreemption: 'STOP'}; spec.followsSpotPrice = {}; spec.recoveryPolicy = 'FAIL'; }
    const op = await api(c, '/compute/v1/instances', {method: 'POST', body: JSON.stringify({metadata: {parentId: project, name, labels: {managed_by: 'apicheck'}}, spec}), headers: {'x-idempotency-key': String(p.spec.launchId || crypto.randomUUID())}});
    const id = op && op.resourceId;
    // wait for the operation: placement failures arrive here
    let done = op && op.status ? op : null;
    for (let i = 0; !done && i < 160; i++) { await sleep(1500); const o = await api(c, '/compute/v1/instances/operations/' + encodeURIComponent(op.id)).catch(() => null); if (o && o.status) done = o; }
    if (done && done.status && done.status.code) {
      const msg = messageOf(done.status, '', 0), kind = classify(400, done.status, msg) || 'invalid';
      if (id) await remove(c, id);   // a failed VM keeps its name, its boot disk and its quota until deleted
      // a finished operation is a definite answer (status 1): the engine must not go looking for this machine as if the answer were unclear
      throw new ProviderError(kind, msg, 1);
    }
    if (!id) throw new ProviderError('http', 'Nebius accepted the request but returned no instance id.');
    if (!done) {
      const inst = await api(c, '/compute/v1/instances/' + encodeURIComponent(id)).catch(() => null), st = inst && inst.status && inst.status.state;
      if (st !== 'RUNNING' && st !== 'STARTING') throw new Unclear(`Nebius is still creating machine ${id} (state ${st || 'unknown'}); it may still start or fail.`, id);
    }
    return {extId: id, name, detail: {project, region: p.region, operation: op.id}};
  },
  async find(c, p) {
    const project = c.meta && c.meta.projects && c.meta.projects[p.region];
    if (!project) return null;
    try {
      const i = await api(c, '/compute/v1/instances/get-by-name?parentId=' + encodeURIComponent(project) + '&name=' + encodeURIComponent(vmName(p.name)));
      const st = i && i.status && i.status.state;
      // a machine that failed to place is not a machine; launch() deletes those
      if (i && i.metadata && i.metadata.id && st === 'ERROR') { await remove(c, i.metadata.id); return null; }
      if (st === 'DELETING') return null;
      return i && i.metadata && i.metadata.id ? {extId: i.metadata.id, status: st} : null;
    } catch (e) { if (e instanceof ProviderError && (e.status === 404 || /not.?found/i.test(e.message))) return null; throw e; }
  },
  async active(c) {
    const projects: Record<string, string> = (c.meta && c.meta.projects) || {}, out: Machine[] = [];
    for (const [region, pid] of Object.entries(projects)) for (const i of await list(c, '/compute/v1/instances?parentId=' + encodeURIComponent(pid))) {
      const st = i.status && i.status.state, r = i.spec && i.spec.resources;
      if (st === 'DELETING' || st === 'ERROR') continue;   // ERROR machines are failed placements, deleted by the launch
      out.push({extId: i.metadata.id, name: i.metadata.name || '', config: r ? r.platform + '|' + r.preset : '', region, status: st || 'unknown'});
    }
    return out;
  },
  async preflight(c, spec) {
    const out: Check[] = [], s = spec.launch || {}, kind = kindOf(c, spec), projects: Record<string, string> = (c.meta && c.meta.projects) || {};
    const tenant = c.meta && c.meta.tenant;
    if (!tenant) return [{level: 'fail', text: 'The key has no tenant on record. Check the key again on the Keys page.'}];
    const items = await list(c, '/capacity/v1/resource-advice?parentId=' + encodeURIComponent(tenant));
    const sold = (cfg: string) => [...new Set(items.filter((it: any) => it.spec && it.spec.computeInstance && it.spec.computeInstance.platform + '|' + it.spec.computeInstance.preset.name === cfg).map((it: any) => it.spec.region))] as string[];
    const regions: string[] = spec.regions && spec.regions.length ? spec.regions : [...new Set<string>((spec.configs || []).flatMap(sold))];
    if (!regions.length) out.push({level: 'fail', text: 'None of the chosen presets is sold in any region this account sees.'});
    const imageFam = s.image || 'ubuntu24.04-cuda13.0';
    for (const region of regions) {
      const pid = projects[region];
      if (!pid) { out.push({level: 'fail', text: `No project in ${region}: the service account needs the editor role in that region's project.`}); continue; }
      const platforms = await list(c, '/compute/v1/platforms?parentId=' + encodeURIComponent(pid));
      for (const cfg of spec.configs || []) {
        const [platform, preset] = String(cfg).split('|'), pl = platforms.find((x: any) => x.metadata && x.metadata.name === platform);
        if (!sold(cfg).includes(region)) continue;
        if (!pl) out.push({level: 'fail', text: `${region}: the platform ${platform} is not available to this project.`});
        else if (!((pl.spec && pl.spec.presets) || []).some((x: any) => x.name === preset)) out.push({level: 'fail', text: `${region}: ${platform} has no preset ${preset}.`});
        else out.push({level: 'ok', text: `${region}: ${platform} with ${preset}.`});
        const adv = items.filter((it: any) => it.spec.region === region && it.spec.computeInstance.platform + '|' + it.spec.computeInstance.preset.name === cfg).map((it: any) => it.status && it.status[kind]).filter(Boolean);
        if (adv.length && adv.every((st: any) => st.availabilityLevel === 'AVAILABILITY_LEVEL_LIMIT_REACHED')) out.push({level: 'fail', text: `${region}: Nebius reports "limit reached" for ${preset}: your quota (or a capacity block) makes a launch impossible. Raise the GPU quota in the console (Administration, Limits).`});
        else if (adv.length) { const lim = Math.max(...adv.map((st: any) => Number(st.limit) || 0)); if (lim) out.push({level: 'ok', text: `${region}: quota allows ${lim} of ${preset}.`}); }
      }
      const subnetOk = s.subnet && (!s.subnet_region || s.subnet_region === region) ? (await list(c, '/vpc/v1/subnets?parentId=' + encodeURIComponent(pid))).some((x: any) => x.metadata.id === s.subnet) : !!(await firstSubnet(c, pid));
      out.push(subnetOk ? {level: 'ok', text: `${region}: subnet found.`} : {level: 'fail', text: `${region}: ${s.subnet ? 'the chosen subnet does not exist any more' : 'the project has no subnet'}.`});
      const imgs = await list(c, '/compute/v1/images/list-public?region=' + encodeURIComponent(region));
      const im = imgs.find((x: any) => x.spec && x.spec.imageFamily === imageFam);
      if (!im) out.push({level: 'fail', text: `${region}: no public image of the family ${imageFam}.`});
      else {
        const bad = (spec.configs || []).filter((cfg: string) => { const [platform, preset] = cfg.split('|'), u = im.spec.unsupportedPresets || []; return u.some((x: any) => x.platform === platform && (!x.preset || x.preset === preset)) || (im.spec.unsupportedPlatforms && im.spec.unsupportedPlatforms[platform]); });
        out.push(bad.length ? {level: 'fail', text: `${region}: the image ${imageFam} does not support ${bad.join(', ')}.`} : {level: 'ok', text: `${region}: image ${imageFam}.`});
      }
      if (s.filesystem && (!s.filesystem_region || s.filesystem_region === region)) {
        const f = (await list(c, '/compute/v1/filesystems?parentId=' + encodeURIComponent(pid))).find((x: any) => x.metadata.id === s.filesystem);
        out.push(f ? {level: 'ok', text: `${region}: filesystem "${f.metadata.name}".`} : {level: 'fail', text: `${region}: the chosen filesystem does not exist any more.`});
      }
    }
    const keys = String(s.ssh_keys || '').split('\n').map((x: string) => x.trim()).filter(Boolean);
    if (s.user_data) out.push(/ssh_authorized_keys|ssh-(ed25519|rsa)|ecdsa-/.test(s.user_data) ? {level: 'ok', text: 'Your own cloud-init sets the login.'} : {level: 'warn', text: 'Your own cloud-init has no ssh_authorized_keys: check that you can log in.'});
    else out.push(keys.length ? {level: 'ok', text: `${keys.length} SSH key${keys.length === 1 ? '' : 's'} for the user ${s.username || 'ubuntu'}.`} : {level: 'fail', text: 'No SSH public key is given, so nobody could log in to the machine.'});
    return out;
  },
  async instance(c, extId) {
    const i = await api(c, '/compute/v1/instances/' + encodeURIComponent(extId));
    if (!i) return null;
    const nic = i.status && i.status.networkInterfaces && i.status.networkInterfaces[0];
    return {status: i.status && i.status.state, ip: nic && nic.publicIpAddress ? String(nic.publicIpAddress.address || '').replace(/\/\d+$/, '') : null, privateIp: nic && nic.ipAddress ? String(nic.ipAddress.address || '').replace(/\/\d+$/, '') : null};
  }
};
