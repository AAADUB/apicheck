// Types are loose here on purpose: these tests drive the Worker through its HTTP API and the Durable Object instance.
// @ts-nocheck
import {env, SELF, runInDurableObject} from 'cloudflare:test';
import {describe, it, expect, beforeAll} from 'vitest';
import {sealKey, openKey} from '../src/crypto';
import {lambda} from '../src/providers/lambda';
import {upcloud} from '../src/providers/upcloud';
import {runpod} from '../src/providers/runpod';
import {nebius, readCreds} from '../src/providers/nebius';
import {ProviderError} from '../src/types';
import {cleanLaunch} from '../../shared/providers.js';

const E = env as any, ORIGIN = 'https://check.example';
type Hit = {url: string; init: any};
/* a fetch that answers from a table of URL fragments and remembers what it was asked */
function mock(table: [string, number, any][], log: Hit[] = []) {
  return Object.assign((async (input: any, init: any = {}) => {
    const url = String(input instanceof Request ? input.url : input); log.push({url, init});
    const hit = table.find(([k]) => url.includes(k));
    if (!hit) return new Response('{"error":"nothing here"}', {status: 404});
    return new Response(JSON.stringify(hit[2]), {status: hit[1], headers: {'content-type': 'application/json'}});
  }) as typeof fetch, {log});
}
const ctx = (f: typeof fetch, secret = 'secret_abc_0123456789', meta: any = {}, params: any = {}) => Object.assign({secret, meta, fetch: f, now: Date.now()}, {memo: new Map(), params});
const kindOf = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return e instanceof ProviderError ? e.kind : 'other:' + (e as Error).message; } };

describe('Lambda adapter', () => {
  const types = {data: {
    gpu_8x_h100_sxm5: {instance_type: {name: 'gpu_8x_h100_sxm5', description: '8x H100 (80 GB SXM5)', gpu_description: 'H100 (80 GB SXM5)', price_cents_per_hour: 3192, specs: {vcpus: 208, memory_gib: 1800, storage_gib: 22000, gpus: 8}}, regions_with_capacity_available: [{name: 'us-east-1', description: 'Virginia, USA'}]},
    gpu_1x_a10: {instance_type: {name: 'gpu_1x_a10', description: '1x A10 (24 GB PCIe)', gpu_description: 'A10 (24 GB PCIe)', price_cents_per_hour: 75, specs: {vcpus: 30, memory_gib: 200, storage_gib: 1400, gpus: 1}}, regions_with_capacity_available: []}
  }};
  it('reads offers and the catalogue', async () => {
    const f = mock([['/instance-types', 200, types], ['/regions', 200, {data: [{name: 'us-west-1', description: 'California, USA'}]}], ['/ssh-keys', 200, {data: [{id: 'k1', name: 'laptop'}]}], ['/images', 200, {data: [{family: 'lambda-stack-24-04', name: 'Lambda Stack 24.04'}]}], ['/filesystems', 200, {data: [{name: 'data', region: {name: 'us-east-1'}}]}], ['/firewall-rulesets', 200, {data: []}]]);
    const c = await lambda.catalog(ctx(f));
    expect(c.configs[0]).toMatchObject({id: 'gpu_8x_h100_sxm5', gpus: 8, vcpus: 208, price: 31.92, ramGb: 1933});
    expect(c.offers).toEqual([{config: 'gpu_8x_h100_sxm5', region: 'us-east-1', level: 'yes'}]);
    expect(c.regions.map(r => r.id)).toEqual(['us-east-1', 'us-west-1']);
    expect(c.options.sshKeys).toEqual([{id: 'laptop', name: 'laptop'}]);
    expect(f.log[0].init.headers.authorization).toBe('Bearer secret_abc_0123456789');
    expect(f.log[0].init.headers['user-agent']).toMatch(/APICheck/);
  });
  it('sends one launch request with the documented fields and sorts errors', async () => {
    const f = mock([['/instance-operations/launch', 200, {data: {instance_ids: ['i-1']}}]]);
    const r = await lambda.launch(ctx(f), {config: 'gpu_8x_h100_sxm5', region: 'us-east-1', name: 'comp', spec: {watchId: 'wch_1', launch: {ssh_key: 'laptop', filesystem: 'data', image: 'lambda-stack-24-04'}}});
    expect(r.extId).toBe('i-1');
    const body = JSON.parse(f.log[0].init.body);
    expect(body).toMatchObject({region_name: 'us-east-1', instance_type_name: 'gpu_8x_h100_sxm5', ssh_key_names: ['laptop'], file_system_names: ['data'], image: {family: 'lambda-stack-24-04'}, name: 'comp'});
    expect(body.quantity).toBeUndefined();
    const err = (code: string, status = 400) => mock([['/launch', status, {error: {code, message: 'x'}}]]);
    const plan = {config: 'a', region: 'b', name: 'n', spec: {launch: {ssh_key: 'k'}}};
    expect(await kindOf(lambda.launch(ctx(err('instance-operations/launch/insufficient-capacity')), plan))).toBe('capacity');
    expect(await kindOf(lambda.launch(ctx(err('global/quota-exceeded')), plan))).toBe('quota');
    expect(await kindOf(lambda.launch(ctx(err('global/invalid-api-key', 401)), plan))).toBe('auth');
    expect(await kindOf(lambda.launch(ctx(err('global/rate-limited', 429)), plan))).toBe('rate');
  });
});

describe('UpCloud adapter', () => {
  it('reads free GPU plans per zone and creates a server with explicit storage', async () => {
    const f = mock([['/device/availability', 200, {'fi-hel2': {gpu_plans: {'GPU-96xCPU-1920GB-8xH100': {amount: 1}, 'GPU-8xCPU-64GB-1xL4': {amount: 0}}}}]]);
    expect(await upcloud.offers(ctx(f, 'ucat_tokenvalue123'), {spec: {}})).toEqual([{config: 'GPU-96xCPU-1920GB-8xH100', region: 'fi-hel2', level: 'low', note: '1 free'}]);
    expect(f.log[0].init.headers.authorization).toBe('Bearer ucat_tokenvalue123');
    const g = mock([['/server', 202, {server: {uuid: 'srv-1', state: 'maintenance', title: 'comp'}}]]);
    await upcloud.launch(ctx(g, 'apiuser:pass'), {config: 'GPU-96xCPU-1920GB-8xH100', region: 'fi-hel2', name: 'comp', spec: {launch: {template: 'tpl-uuid', ssh_keys: 'ssh-ed25519 AAAA me\n', disk_size: 500}}});
    expect(g.log[0].init.headers.authorization).toBe('Basic ' + btoa('apiuser:pass'));
    const s = JSON.parse(g.log[0].init.body).server;
    expect(s).toMatchObject({zone: 'fi-hel2', plan: 'GPU-96xCPU-1920GB-8xH100', metadata: 'yes', login_user: {create_password: 'no', ssh_keys: {ssh_key: ['ssh-ed25519 AAAA me']}}});
    expect(s.storage_devices.storage_device[0]).toMatchObject({action: 'clone', storage: 'tpl-uuid', size: 500, tier: 'maxiops'});
    const err = (code: string, status: number) => mock([['/server', status, {error: {error_code: code, error_message: 'x'}}]]);
    const plan = {config: 'p', region: 'fi-hel2', name: 'n', spec: {launch: {template: 't', ssh_keys: 'k'}}};
    expect(await kindOf(upcloud.launch(ctx(err('SERVER_RESOURCES_UNAVAILABLE', 409)), plan))).toBe('capacity');
    expect(await kindOf(upcloud.launch(ctx(err('INSUFFICIENT_CREDITS', 402)), plan))).toBe('money');
    expect(await kindOf(upcloud.launch(ctx(err('SERVER_CORE_LIMIT_REACHED', 403)), plan))).toBe('quota');
    expect(await kindOf(upcloud.launch(ctx(err('METADATA_DISABLED_ON_CLOUD-INIT', 409)), plan))).toBe('invalid');
  });
});

describe('RunPod adapter', () => {
  const gpus = {gpus: [{id: 'NVIDIA H100 80GB HBM3', name: 'H100 SXM', memory: 80, secure: true, community: true, price: {secure: 2.99, community: 2.69}, maxCount: {secure: 8, community: 8}, minRam: 1000, minVcpuCount: 160, availability: 'LOW', dataCenters: [{id: 'US-KS-2', name: 'US Kansas 2', availability: 'LOW'}, {id: 'EU-RO-1', name: 'Romania', availability: 'NONE'}]}]};
  it('asks for availability at the chosen count and builds a v2 pod request', async () => {
    const f = mock([['/catalog/gpus', 200, gpus]]);
    const o = await runpod.offers(ctx(f, 'rpa_x'), {spec: {configs: ['NVIDIA H100 80GB HBM3'], params: {count: 8, cloud: 'SECURE'}}});
    expect(o).toEqual([{config: 'NVIDIA H100 80GB HBM3', region: 'US-KS-2', level: 'low'}]);
    expect(f.log[0].url).toContain('include=AVAILABILITY&product=POD&count=8&cloud=SECURE');
    const g = mock([['/pods', 201, {id: 'pod-1', name: 'comp', status: 'PROVISIONING', cost: 23.92}]]);
    const r = await runpod.launch(ctx(g, 'rpa_x'), {config: 'NVIDIA H100 80GB HBM3', region: 'US-KS-2', name: 'comp', spec: {params: {count: 8, cloud: 'SECURE'}, launch: {network_volume: 'vol1', volume_path: '/workspace', ports: '22/tcp,8888/http', start_ssh: true, env: 'HF_TOKEN=abc\nBAD LINE', disk: 200}}});
    expect(r).toMatchObject({extId: 'pod-1', price: 23.92});
    const b = JSON.parse(g.log[0].init.body);
    expect(b).toMatchObject({name: 'comp', gpu: {id: 'NVIDIA H100 80GB HBM3', count: 8}, cloud: 'SECURE', dataCenterIds: ['US-KS-2'], ports: ['22/tcp', '8888/http'], startSsh: true, disk: 200, mounts: {network: [{volumeId: 'vol1', path: '/workspace'}]}, env: {HF_TOKEN: 'abc'}});
    expect(b.image).toMatch(/^runpod\/pytorch/);
    const plan = {config: 'x', region: 'y', name: 'n', spec: {launch: {}}};
    expect(await kindOf(runpod.launch(ctx(mock([['/pods', 400, {detail: 'no machine'}]])), plan))).toBe('capacity');
    expect(await kindOf(runpod.launch(ctx(mock([['/pods', 402, {detail: 'balance'}]])), plan))).toBe('money');
    expect(await kindOf(runpod.launch(ctx(mock([['/pods', 422, {detail: 'bad'}]])), plan))).toBe('invalid');
  });
});

describe('Nebius adapter', () => {
  it('reads the credentials file and refuses a PKCS#1 key', () => {
    expect(readCreds(JSON.stringify({'subject-credentials': {alg: 'RS256', 'private-key': '-----BEGIN PRIVATE KEY-----\nAAA\n-----END PRIVATE KEY-----', kid: 'publickey-1', iss: 'serviceaccount-1', sub: 'serviceaccount-1'}}))).toMatchObject({kid: 'publickey-1', iss: 'serviceaccount-1'});
    expect(() => readCreds(JSON.stringify({'subject-credentials': {'private-key': '-----BEGIN RSA PRIVATE KEY-----', kid: 'a', iss: 'b'}}))).toThrow(/PKCS#1/);
  });
  it('signs a JWT, exchanges it, and maps the capacity advisor', async () => {
    const pair = await crypto.subtle.generateKey({name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256'}, true, ['sign', 'verify']) as CryptoKeyPair;
    const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey) as ArrayBuffer);
    const pem = '-----BEGIN PRIVATE KEY-----\n' + btoa(String.fromCharCode(...der)) + '\n-----END PRIVATE KEY-----';
    const secret = JSON.stringify({'subject-credentials': {alg: 'RS256', 'private-key': pem, kid: 'publickey-t' + Math.random(), iss: 'serviceaccount-x', sub: 'serviceaccount-x'}});
    const item = (level: string, fabric: string) => ({spec: {region: 'eu-north1', fabric, computeInstance: {platform: 'gpu-h100-sxm', preset: {name: '8gpu-128vcpu-1600gb', resources: {vcpuCount: 128, memoryGibibytes: 1600, gpuCount: 8}}, gpuMemoryGigabytes: 80}}, status: {onDemand: {available: 1, limit: 4, availabilityLevel: level, dataState: 'DATA_STATE_FRESH'}}});
    const f = mock([['oauth2/token/exchange', 200, {access_token: 'tok', expires_in: 43200}], ['/capacity/v1/resource-advice', 200, {items: [item('AVAILABILITY_LEVEL_LOW', 'fabric-2'), item('AVAILABILITY_LEVEL_MEDIUM', 'fabric-3')]}]]);
    const o = await nebius.offers(ctx(f, secret, {tenant: 'tenant-1'}), {spec: {params: {kind: 'on_demand'}}});
    expect(o).toEqual([{config: 'gpu-h100-sxm|8gpu-128vcpu-1600gb', region: 'eu-north1', level: 'medium', note: '1 launchable'}]);
    const ex = f.log.find(h => h.url.includes('token/exchange'))!;
    const form = new URLSearchParams(ex.init.body.toString()), jwt = form.get('subject_token')!.split('.');
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:token-exchange');
    const pub = JSON.parse(atob(jwt[1].replace(/-/g, '+').replace(/_/g, '/')));
    expect(pub).toMatchObject({iss: 'serviceaccount-x', sub: 'serviceaccount-x', aud: 'token-service.iam.new.nebiuscloud.net'});
    const sig = Uint8Array.from(atob(jwt[2].replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - jwt[2].length % 4) % 4)), ch => ch.charCodeAt(0));
    expect(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', pair.publicKey, sig, new TextEncoder().encode(jwt[0] + '.' + jwt[1]))).toBe(true);
    expect(f.log.find(h => h.url.includes('resource-advice'))!.init.headers.authorization).toBe('Bearer tok');
  });
});

describe('launch settings', () => {
  it('cleans fields by the provider form', () => {
    expect(cleanLaunch('lambda', {ssh_key: 'laptop', image: '', name: '  comp  ', extra: 'dropped'})).toEqual({ssh_key: 'laptop', name: 'comp'});
    expect(() => cleanLaunch('lambda', {})).toThrow();
    expect(() => cleanLaunch('lambda', {ssh_key: 'k', hostname: 'Bad Host'})).toThrow();
    expect(cleanLaunch('upcloud', {template: 't', ssh_keys: 'k'})).toMatchObject({disk_size: 200, disk_tier: 'maxiops'});
  });
});

/* ---------- the API and the engine, end to end with the test provider ---------- */
let cookie = '';
const api = async (method: string, path: string, body?: unknown) => {
  const res = await SELF.fetch(ORIGIN + '/api' + path, {method, headers: {'content-type': 'application/json', 'x-apicheck': '1', origin: ORIGIN, cookie}, body: body ? JSON.stringify(body) : undefined});
  const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  return {status: res.status, data: await res.json() as any};
};
const at = (sec: number) => { const base = Math.floor(Date.now() / 60000) * 60000 + 60000; return base + sec * 1000; };

describe('workspace', () => {
  let keyId = '', watchId = '', launchWatch = '';
  beforeAll(async () => {
    expect((await api('POST', '/auth/setup', {token: 'setup-token-for-tests-0123456789abc', email: 'admin@example.com', password: 'correct horse battery'})).status).toBe(201);
  });
  it('keeps keys sealed and checks them with the provider', async () => {
    expect((await api('POST', '/keys', {provider: 'fake', key: 'wrong-key-value-123'})).data.error).toBe('key_rejected');
    const r = await api('POST', '/keys', {provider: 'fake', label: 'Test', key: 'test-key-value-123456'});
    expect(r.status).toBe(201); keyId = r.data.id;
    const row = await E.DB.prepare('SELECT key_enc, key_tail, user_id FROM keys WHERE id = ?').bind(keyId).first();
    expect(new TextDecoder().decode(new Uint8Array(row.key_enc))).not.toContain('test-key');
    expect(row.key_tail).toBe('3456');
    expect(await openKey(E, new Uint8Array(row.key_enc), keyId, row.user_id)).toBe('test-key-value-123456');
    const list = await api('GET', '/keys');
    expect(JSON.stringify(list.data)).not.toContain('test-key-value');
    const cat = await api('GET', `/keys/${keyId}/catalog`);
    expect(cat.data.configs.length).toBe(3);
  });
  it('validates a watch and refuses impossible settings', async () => {
    const base = {keyId, name: 'H100 for the competition', mode: 'notify', every: 5, spec: {configs: ['fake_8x_h100'], regions: [], names: {fake_8x_h100: '8x H100 SXM (test)'}, prices: {fake_8x_h100: 31.92}}};
    expect((await api('POST', '/watches', {...base, every: 1})).data).toMatchObject({error: 'every', min: 2});
    expect((await api('POST', '/watches', {...base, spec: {configs: []}})).data.error).toBe('configs');
    expect((await api('POST', '/watches', {...base, mode: 'launch', spec: {...base.spec, launch: {}}})).data).toMatchObject({error: 'launch_field', field: 'ssh_key'});
    const ok = await api('POST', '/watches', {...base, paused: true}); expect(ok.status).toBe(201); watchId = ok.data.id;
    const l = await api('POST', '/watches', {...base, name: 'Start it', mode: 'launch', maxLaunch: 1, paused: true, spec: {...base.spec, regions: ['test-west-1'], launch: {ssh_key: 'laptop', name: 'comp'}}});
    expect(l.status).toBe(201); launchWatch = l.data.id;
  });
  it('sees capacity come and go, and tells once per window', async () => {
    await E.DB.prepare("UPDATE watches SET state = 'on' WHERE id = ?").bind(watchId).run();
    const stub = E.WATCHER.get(E.WATCHER.idFromName(keyId));
    await runInDurableObject(stub, async (w: any) => {
      w.keyId = keyId; w.loadedAt = 0;
      await w.tick(at(5));                                             // east is free in the first 20 s of the minute
      let ev = (await E.DB.prepare('SELECT kind, title FROM events WHERE watch_id = ? ORDER BY id').bind(watchId).all()).results;
      expect(ev.map((e: any) => e.kind)).toContain('seen');
      expect((await E.DB.prepare("SELECT COUNT(*) AS n FROM notices WHERE watch_id = ? AND kind = 'seen'").bind(watchId).first('n'))).toBe(1);
      w.runs.get(watchId).next = 0; await w.tick(at(10));              // still free: no second message
      expect((await E.DB.prepare("SELECT COUNT(*) AS n FROM notices WHERE watch_id = ? AND kind = 'seen'").bind(watchId).first('n'))).toBe(1);
      w.runs.get(watchId).next = 0; await w.tick(at(25));              // gone
      ev = (await E.DB.prepare('SELECT kind FROM events WHERE watch_id = ? ORDER BY id').bind(watchId).all()).results;
      expect(ev.map((e: any) => e.kind)).toContain('gone');
      const win = await E.DB.prepare('SELECT start_at, end_at FROM windows WHERE watch_id = ?').bind(watchId).all();
      expect(win.results.length).toBe(1); expect(win.results[0].end_at).toBeGreaterThan(win.results[0].start_at);
    });
  });
  it('starts one machine, records it, and finishes the watch', async () => {
    await E.DB.prepare("UPDATE watches SET state = 'on' WHERE id = ?").bind(launchWatch).run();
    const stub = E.WATCHER.get(E.WATCHER.idFromName(keyId));
    await runInDurableObject(stub, async (w: any) => {
      w.loadedAt = 0; w.launchNext = 0;
      await w.tick(at(15));                                            // west is not free yet: nothing happens
      expect((await E.DB.prepare('SELECT COUNT(*) AS n FROM launches WHERE watch_id = ?').bind(launchWatch).first('n'))).toBe(0);
      w.runs.get(launchWatch).next = 0; await w.tick(at(33));          // west is free: launch
      const l = await E.DB.prepare('SELECT state, ext_id, target, region FROM launches WHERE watch_id = ?').bind(launchWatch).all();
      expect(l.results).toHaveLength(1); expect(l.results[0]).toMatchObject({state: 'created', target: 'fake_8x_h100', region: 'test-west-1'});
      const wr = await E.DB.prepare('SELECT state, launched FROM watches WHERE id = ?').bind(launchWatch).first();
      expect(wr).toMatchObject({state: 'done', launched: 1});
    });
    expect((await api('PATCH', '/watches/' + launchWatch, {state: 'on'})).data.error).toBe('launch_done');
    const m = await api('GET', '/launches'); expect(m.data.items[0]).toMatchObject({state: 'created', provider: 'fake'});
  });
  it('stops on a refusal that would only repeat, and tells why', async () => {
    const r = await api('POST', '/watches', {keyId, name: 'Refused', mode: 'launch', every: 5, spec: {configs: ['fake_1x_a100'], launch: {ssh_key: 'laptop', fail: 'quota'}}});
    const stub = E.WATCHER.get(E.WATCHER.idFromName(keyId));
    await runInDurableObject(stub, async (w: any) => { w.loadedAt = 0; w.launchNext = 0; await w.tick(Date.now()); });
    const wr = await E.DB.prepare('SELECT state, stop_reason FROM watches WHERE id = ?').bind(r.data.id).first();
    expect(wr.state).toBe('stopped'); expect(wr.stop_reason).toMatch(/account may not/);
    expect((await E.DB.prepare("SELECT state FROM launches WHERE watch_id = ?").bind(r.data.id).first('state'))).toBe('failed');
  });
  it('never shows one person another person\'s rows', async () => {
    const inv = await api('POST', '/admin/users', {email: 'member@example.com'});
    const mine = cookie; cookie = '';
    expect((await api('POST', '/auth/accept', {token: inv.data.invite, password: 'member password 1'})).status).toBe(201);
    expect((await api('GET', '/keys')).data.items).toEqual([]);
    expect((await api('GET', '/watches/' + watchId)).status).toBe(404);
    expect((await api('GET', `/keys/${keyId}/catalog`)).status).toBe(404);
    expect((await api('GET', '/launches')).data.items).toEqual([]);
    expect((await api('GET', '/admin/users')).status).toBe(403);
    cookie = mine;
  });
  it('refuses writes without the CSRF header', async () => {
    const res = await SELF.fetch(ORIGIN + '/api/keys', {method: 'POST', headers: {cookie, 'content-type': 'application/json'}, body: '{}'});
    expect(res.status).toBe(403);
  });
});
