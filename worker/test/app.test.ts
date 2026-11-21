// Types are loose here on purpose: these tests drive the Worker through its HTTP API and the Durable Object instance.
// @ts-nocheck
import {env, SELF, runInDurableObject} from 'cloudflare:test';
import {describe, it, expect, beforeAll} from 'vitest';
import {sealKey, openKey} from '../src/crypto';
import {lambda} from '../src/providers/lambda';
import {upcloud} from '../src/providers/upcloud';
import {runpod} from '../src/providers/runpod';
import {nebius, readCreds} from '../src/providers/nebius';
import {hyperstack} from '../src/providers/hyperstack';
import {digitalocean} from '../src/providers/digitalocean';
import {vultr, metalOf, vcgOf} from '../src/providers/vultr';
import {gcore, ramOf} from '../src/providers/gcore';
import {MADE} from '../src/providers/fake';
import {ProviderError} from '../src/types';
import {paceOf} from '../src/providers/net';
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
  it('reads the credentials file the CLI writes', () => {
    expect(readCreds(JSON.stringify({'subject-credentials': {alg: 'RS256', 'private-key': '-----BEGIN PRIVATE KEY-----\nAAA\n-----END PRIVATE KEY-----', kid: 'publickey-1', iss: 'serviceaccount-1', sub: 'serviceaccount-1'}}))).toMatchObject({kid: 'publickey-1', iss: 'serviceaccount-1'});
    expect(() => readCreds(JSON.stringify({'subject-credentials': {kid: 'a'}}))).toThrow(/private-key/);
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

describe('Hyperstack adapter', () => {
  const flavors = {status: true, data: [
    {gpu: 'H100-80G-SXM5', region_name: 'CANADA-1', flavors: [{name: 'n3-H100-SXM5x8', region_name: 'CANADA-1', gpu: 'H100-80G-SXM5', gpu_count: 8, cpu: 192, ram: 1800, disk: 100, ephemeral: 32000, stock_available: false}]},
    {gpu: 'H100-80G-SXM5', region_name: 'US-1', flavors: [{name: 'n3-H100-SXM5x8', region_name: 'US-1', gpu: 'H100-80G-SXM5', gpu_count: 8, cpu: 192, ram: 960, disk: 100, ephemeral: 20000, stock_available: true}]},
    {gpu: '', region_name: 'CANADA-1', flavors: [{name: 'n1-cpu-small', region_name: 'CANADA-1', gpu: '', gpu_count: 0, cpu: 4, ram: 4, stock_available: true}]}]};
  const stocks = {stocks: [{region: 'US-1', 'stock-type': 'GPU', models: [{model: 'H100-80G-SXM5', available: '8', configurations: {'1x': 8, '2x': 4, '4x': 2, '8x': 1, '10x': 0}}]}]};
  const envs = {environments: [{name: 'us', region: 'US-1'}, {name: 'ca', region: 'CANADA-1'}], count: 2};
  const keys = {keypairs: [{name: 'laptop', environment: {name: 'us', region: 'US-1'}}], count: 1};
  const images = {images: [{region_name: 'US-1', type: 'Ubuntu', images: [{name: 'Ubuntu Server 22.04 LTS R535 CUDA 12.2', region_name: 'US-1'}, {name: 'Ubuntu Server 24.04 LTS R570 CUDA 12.8 with Docker', region_name: 'US-1'}]}]};
  it('reads stock per flavor and region, and only counts regions it could launch in', async () => {
    const f = mock([['/core/flavors', 200, flavors], ['/core/stocks', 200, stocks], ['/core/environments', 200, envs], ['/core/keypairs', 200, keys]]);
    const o = await hyperstack.offers(ctx(f, 'hs-key-0000000001'), {mode: 'notify', spec: {}});
    expect(o).toEqual([{config: 'n3-H100-SXM5x8', region: 'US-1', level: 'yes', note: '1 machine of 8 GPUs deployable'}]);
    expect(f.log[0].init.headers.api_key).toBe('hs-key-0000000001');
    const g = mock([['/core/flavors', 200, {data: [{...flavors.data[0], flavors: [{...flavors.data[0].flavors[0], stock_available: true}]}]}], ['/core/stocks', 200, stocks], ['/core/environments', 200, envs], ['/core/keypairs', 200, keys]]);
    expect(await hyperstack.offers(ctx(g, 'hs-key-0000000002'), {mode: 'launch', spec: {}})).toEqual([]);   // in stock in CANADA-1, but no key there
  });
  it('launches with the region\'s environment, key and image, and settles errors', async () => {
    const f = mock([['/core/environments', 200, envs], ['/core/keypairs', 200, keys], ['/core/images', 200, images], ['/core/virtual-machines/77', 200, {instance: {id: 77, status: 'ACTIVE'}}], ['/core/virtual-machines', 200, {status: true, instances: [{id: 77, name: 'comp-abc123', status: 'CREATING'}]}]]);
    const plan = {config: 'n3-H100-SXM5x8', region: 'US-1', name: 'comp-abc123', spec: {launch: {public_ip: true}}};
    const r = await hyperstack.launch(ctx(f, 'hs-key-0000000003'), plan);
    expect(r).toMatchObject({extId: '77', detail: {status: 'ACTIVE', environment: 'us', key: 'laptop', image: 'Ubuntu Server 24.04 LTS R570 CUDA 12.8 with Docker'}});
    const body = JSON.parse(f.log.find(h => h.init.method === 'POST')!.init.body);
    expect(body).toMatchObject({name: 'comp-abc123', environment_name: 'us', flavor_name: 'n3-H100-SXM5x8', key_name: 'laptop', count: 1, assign_floating_ip: true});
    expect(body.security_rules[0]).toMatchObject({direction: 'ingress', protocol: 'tcp', port_range_min: 22, port_range_max: 22});
    expect(await kindOf(hyperstack.launch(ctx(f, 'hs-key-0000000004'), {...plan, region: 'CANADA-1'}))).toBe('invalid');   // no key in that environment
    const err = (status: number, message: string) => mock([['/core/environments', 200, envs], ['/core/keypairs', 200, keys], ['/core/images', 200, images], ['/core/virtual-machines', status, {status: false, message, error_reason: 'bad_request'}]]);
    expect(await kindOf(hyperstack.launch(ctx(err(400, 'Insufficient balance to create the resource'), 'hs-key-0000000005'), plan))).toBe('money');
    expect(await kindOf(hyperstack.launch(ctx(err(400, 'Not enough GPUs in stock for this flavor'), 'hs-key-0000000006'), plan))).toBe('capacity');
    expect(await kindOf(hyperstack.launch(ctx(err(401, 'Unauthorized'), 'hs-key-0000000007'), plan))).toBe('auth');
    expect(await kindOf(hyperstack.launch(ctx(err(429, ''), 'hs-key-0000000008'), plan))).toBe('rate');
    const found = await hyperstack.find(ctx(mock([['/core/virtual-machines', 200, {instances: [{id: 9, name: 'comp-abc123x', status: 'ACTIVE'}, {id: 8, name: 'comp-abc123', status: 'BUILD'}]}]]), 'hs-key-0000000009'), plan);
    expect(found).toEqual({extId: '8', status: 'BUILD'});
  });
});

describe('DigitalOcean adapter', () => {
  const h100x8 = {slug: 'gpu-h100x8-640gb', memory: 1966080, vcpus: 160, disk: 2046, price_hourly: 35.28, regions: ['ams3', 'nyc2'], available: true, description: 'H100 GPU - 8X', gpu_info: {count: 8, model: 'nvidia_h100', vram: {amount: 80, unit: 'gib'}}};
  const sizes = {sizes: [h100x8, {slug: 's-1vcpu-1gb', memory: 1024, vcpus: 1, regions: ['ams3'], available: true}], links: {}};
  const keys = {ssh_keys: [{id: 11, name: 'laptop', fingerprint: 'aa:bb'}], links: {}};
  it('reads GPU sizes and the datacenters that list them', async () => {
    const f = mock([['/sizes', 200, sizes]]);
    expect(await digitalocean.offers(ctx(f, 'dop_v1_test'), {spec: {}})).toEqual([{config: 'gpu-h100x8-640gb', region: 'ams3', level: 'yes'}, {config: 'gpu-h100x8-640gb', region: 'nyc2', level: 'yes'}]);
    expect(f.log[0].init.headers.authorization).toBe('Bearer dop_v1_test');
    const g = mock([['/sizes', 200, sizes], ['/regions', 200, {regions: [{slug: 'ams3', name: 'Amsterdam 3'}], links: {}}], ['/account/keys', 200, keys], ['/account', 200, {account: {email: 'a@b.c', droplet_limit: 10, status: 'active'}}], ['/balance', 200, {account_balance: '0.00', month_to_date_balance: '1.00'}]]);
    const c = await digitalocean.catalog(ctx(g, 'dop_v1_test'));
    expect(c.configs).toHaveLength(1);
    expect(c.configs[0]).toMatchObject({id: 'gpu-h100x8-640gb', gpus: 8, gpu: 'H100 SXM', ramGb: 2062, price: 35.28});
    expect(c.options.sshKeys).toEqual([{id: '11', name: 'laptop', detail: 'aa:bb'}]);
  });
  it('creates the Droplet with the 8-GPU image, follows the action, and destroys an errored one', async () => {
    const plan = {config: 'gpu-h100x8-640gb', region: 'ams3', name: 'comp-abc123', spec: {launch: {}}};
    const f = mock([['/droplets', 202, {droplet: {id: 7, status: 'new'}, links: {actions: [{id: 99}]}}], ['/actions/99', 200, {action: {status: 'in-progress'}}], ['/account/keys', 200, keys], ['/sizes', 200, sizes]]);
    const r = await (async () => { const g = mock([['/actions/99', 200, {action: {status: 'completed'}}], ['/droplets', 202, {droplet: {id: 7, status: 'new'}, links: {actions: [{id: 99}]}}], ['/account/keys', 200, keys], ['/sizes', 200, sizes]]); const x = await digitalocean.launch(ctx(g), plan); return {x, g}; })();
    expect(r.x.extId).toBe('7');
    const body = JSON.parse(r.g.log.find(h => h.init.method === 'POST').init.body);
    expect(body).toMatchObject({name: 'comp-abc123', region: 'ams3', size: 'gpu-h100x8-640gb', image: 'gpu-h100x8-base', ssh_keys: [11], tags: ['apicheck']});
    const e = mock([['/actions/99', 200, {action: {status: 'errored'}}], ['/droplets', 202, {droplet: {id: 8, status: 'new'}, links: {actions: [{id: 99}]}}], ['/account/keys', 200, keys], ['/sizes', 200, sizes]]);
    expect(await kindOf(digitalocean.launch(ctx(e), plan))).toBe('capacity');
    expect(e.log.some(h => h.init.method === 'DELETE' && h.url.endsWith('/droplets/8'))).toBe(true);
    void f;
  });
  it('sorts errors', async () => {
    const plan = {config: 'gpu-h100x8-640gb', region: 'ams3', name: 'comp', spec: {launch: {}}};
    const err = (status: number, message: string) => mock([['/droplets', status, {id: 'unprocessable_entity', message}], ['/account/keys', 200, keys], ['/sizes', 200, sizes]]);
    expect(await kindOf(digitalocean.launch(ctx(err(422, 'Size is not available in this region.')), plan))).toBe('capacity');
    expect(await kindOf(digitalocean.launch(ctx(err(422, 'creating this/these droplet(s) will exceed your droplet limit')), plan))).toBe('quota');
    expect(await kindOf(digitalocean.launch(ctx(err(422, 'You specified an invalid image for Droplet creation.')), plan))).toBe('invalid');
    expect(await kindOf(digitalocean.launch(ctx(err(401, 'Unable to authenticate you')), plan))).toBe('auth');
    expect(await kindOf(digitalocean.launch(ctx(err(429, 'API rate limit exceeded.')), plan))).toBe('rate');
  });
  it('lists GPU Droplets for the account guard and finds one by name', async () => {
    const f = mock([['/droplets?type=gpus', 200, {droplets: [{id: 7, name: 'comp-abc123', status: 'new', size_slug: 'gpu-h100x8-640gb', region: {slug: 'ams3'}}], links: {}}]]);
    expect(await digitalocean.active(ctx(f), {})).toEqual([{extId: '7', name: 'comp-abc123', config: 'gpu-h100x8-640gb', region: 'ams3', status: 'new'}]);
    expect(await digitalocean.find(ctx(f), {config: 'gpu-h100x8-640gb', region: 'ams3', name: 'comp-abc123', spec: {}})).toEqual({extId: '7', status: 'new'});
    expect(f.log[0].url).toContain('type=gpus');
  });
});

describe('Vultr adapter', () => {
  const metal = {plans_metal: [{id: 'vbm-112c-2048gb-8-h100-gpu', cpu_count: 112, cpu_threads: 224, ram: 2063720, disk: 1920, disk_count: 1, monthly_cost: 17461.6, type: 'NVMe', locations: ['ams', 'ewr']}, {id: 'vbm-4c-32gb', cpu_count: 4, ram: 32768, monthly_cost: 120, locations: ['ams']}], meta: {links: {next: ''}}};
  const vcg = {plans: [{id: 'vcg-h100-216c-1914gb-640vram', vcpu_count: 216, ram: 1959936, disk: 13312, gpu_vram_gb: 640, gpu_type: 'NVIDIA_H100', monthly_cost: 17461.6, hourly_cost: 23.92, locations: ['fra']}], meta: {links: {next: ''}}};
  const os = {os: [{id: 1743, name: 'Ubuntu 22.04 LTS x64', arch: 'x64', family: 'ubuntu'}, {id: 2284, name: 'Ubuntu 24.04 LTS x64', arch: 'x64', family: 'ubuntu'}, {id: 124, name: 'Windows 2012 R2 x64', arch: 'x64', family: 'windows'}], meta: {links: {next: ''}}};
  const keys = {ssh_keys: [{id: 'k-1', name: 'laptop'}], meta: {links: {next: ''}}};
  it('reads GPU plans from both lists', () => {
    expect(metalOf(metal.plans_metal[0])).toMatchObject({kind: 'metal', gpus: 8, gpu: 'H100', ramGb: 2164, price: 23.92});
    expect(metalOf(metal.plans_metal[1])).toBe(null);
    expect(vcgOf(vcg.plans[0])).toMatchObject({kind: 'vcg', gpus: 8, gpu: 'H100', price: 23.92});
  });
  it('asks only the regions the watch names, where the plan is sold', async () => {
    const f = mock([['/plans-metal', 200, metal], ['/plans?type=vcg', 200, vcg], ['/regions/ams/availability', 200, {available_plans: ['vbm-112c-2048gb-8-h100-gpu', 'vbm-4c-32gb']}], ['/regions/ewr/availability', 200, {available_plans: []}]]);
    expect(await vultr.offers(ctx(f, 'VULTRKEY'), {spec: {configs: ['vbm-112c-2048gb-8-h100-gpu'], regions: ['ams']}})).toEqual([{config: 'vbm-112c-2048gb-8-h100-gpu', region: 'ams', level: 'yes'}]);
    expect(f.log.some(h => h.url.includes('/regions/ewr/'))).toBe(false);
    expect(f.log[0].init.headers.authorization).toBe('Bearer VULTRKEY');
  });
  it('creates bare metal and Cloud GPU machines on their own endpoints and sorts errors', async () => {
    const f = mock([['/bare-metals', 202, {bare_metal: {id: 'bm-1', status: 'pending'}}], ['/os', 200, os], ['/ssh-keys', 200, keys]]);
    const r = await vultr.launch(ctx(f), {config: 'vbm-112c-2048gb-8-h100-gpu', region: 'ams', name: 'comp-abc123', spec: {launch: {user_data: 'echo hi'}}});
    expect(r.extId).toBe('bm-1');
    const body = JSON.parse(f.log.find(h => h.init.method === 'POST').init.body);
    expect(body).toMatchObject({region: 'ams', plan: 'vbm-112c-2048gb-8-h100-gpu', os_id: 2284, label: 'comp-abc123', sshkey_id: ['k-1'], user_data: btoa('echo hi'), activation_email: false});
    const g = mock([['/instances', 202, {instance: {id: 'vm-1', status: 'pending'}}], ['/os', 200, os], ['/ssh-keys', 200, keys]]);
    expect((await vultr.launch(ctx(g), {config: 'vcg-h100-216c-1914gb-640vram', region: 'fra', name: 'comp', spec: {launch: {}}})).extId).toBe('vm-1');
    expect(JSON.parse(g.log.find(h => h.init.method === 'POST').init.body).backups).toBe('disabled');
    const err = (status: number, error: string) => mock([['/bare-metals', status, {error, status}], ['/os', 200, os], ['/ssh-keys', 200, keys]]);
    const plan = {config: 'vbm-112c-2048gb-8-h100-gpu', region: 'ams', name: 'comp', spec: {launch: {}}};
    expect(await kindOf(vultr.launch(ctx(err(400, 'Plan is not available in the selected region.')), plan))).toBe('capacity');
    expect(await kindOf(vultr.launch(ctx(err(400, 'Insufficient funds to deploy this server.')), plan))).toBe('money');
    expect(await kindOf(vultr.launch(ctx(err(403, 'Unauthorized IP address: 104.28.1.1')), plan))).toBe('auth');
    expect(await kindOf(vultr.launch(ctx(err(400, 'Invalid os_id')), plan))).toBe('invalid');
  });
  it('guards both kinds of machine and finds one by label', async () => {
    const f = mock([['/bare-metals', 200, {bare_metals: [{id: 'bm-1', label: 'comp-abc123', plan: 'vbm-112c-2048gb-8-h100-gpu', region: 'ams', status: 'pending', power_status: 'running'}], meta: {links: {next: ''}}}], ['/instances', 200, {instances: [], meta: {links: {next: ''}}}]]);
    expect(await vultr.active(ctx(f), {})).toEqual([{extId: 'bm-1', name: 'comp-abc123', config: 'vbm-112c-2048gb-8-h100-gpu', region: 'ams', status: 'pending'}]);
    expect(await vultr.find(ctx(f), {config: 'vbm-112c-2048gb-8-h100-gpu', region: 'ams', name: 'comp-abc123', spec: {}})).toEqual({extId: 'bm-1', status: 'pending'});
  });
});

describe('Gcore adapter', () => {
  const projects = {count: 1, results: [{id: 5, client_id: 9, name: 'default', is_default: true, state: 'ACTIVE'}]};
  const regions = {count: 2, results: [{id: 76, display_name: 'Luxembourg-2', country: 'LU', has_ai_gpu: true, state: 'ACTIVE'}, {id: 1, display_name: 'Manassas', country: 'US', has_ai_gpu: false, state: 'ACTIVE'}]};
  const fl = {count: 2, results: [{name: 'bm3-ai-1xlarge-h100-80-8', capacity: 2, disabled: false, reserved_capacity: 0, hardware_properties: {gpu_count: 8, gpu_model: 'H100'}, hardware_description: {ram: '2TB', cpu: '2x Intel Xeon 8480+', gpu: '8x H100'}, price: {price_per_hour: 30.01, currency_code: 'EUR', price_status: 'show'}},
    {name: 'bm3-ai-1xlarge-a100-80-8', capacity: 0, disabled: false, hardware_properties: {gpu_count: 8, gpu_model: 'A100'}, hardware_description: {ram: '2048 GB'}}]};
  const images = {count: 1, results: [{id: 'img-1', name: 'ubuntu-22.04-x64-nvidia-535', os_distro: 'ubuntu', os_version: '22.04', status: 'active', gpu_driver: 'nvidia-535', architecture: 'x86_64'}]};
  const keys = {count: 1, results: [{id: 'k', name: 'laptop'}]};
  it('reads RAM written either way', () => { expect(ramOf('2TB')).toBe(2048); expect(ramOf('2048 GB')).toBe(2048); expect(ramOf(1856)).toBe(1856); });
  it('reads the available count per flavor and region, with the APIKey prefix taken off', async () => {
    const f = mock([['/cloud/v1/projects', 200, projects], ['/cloud/v1/regions', 200, regions], ['/cloud/v3/gpu/baremetal/5/76/flavors', 200, fl]]);
    const o = await gcore.offers(ctx(f, 'APIKey 1234$gcore-offers'), {spec: {configs: ['bm:bm3-ai-1xlarge-h100-80-8']}});
    expect(o).toEqual([{config: 'bm:bm3-ai-1xlarge-h100-80-8', region: '76', level: 'yes', note: '2 available'}]);
    expect(f.log[0].init.headers.authorization).toBe('APIKey 1234$gcore-offers');
    expect(f.log.some(h => h.url.includes('/gpu/virtual/'))).toBe(false);   // only bare metal is watched
  });
  it('creates a one-server cluster and follows the task', async () => {
    const plan = {config: 'bm:bm3-ai-1xlarge-h100-80-8', region: '76', name: 'comp-abc123', spec: {launch: {user_data: 'echo hi'}}};
    const f = mock([['/cloud/v1/projects', 200, projects], ['/images', 200, images], ['/ssh_keys/5', 200, keys], ['/clusters', 200, {tasks: ['t1']}], ['/tasks/t1', 200, {id: 't1', state: 'FINISHED', created_resources: {ai_clusters: ['c-1']}}]]);
    const r = await gcore.launch(ctx(f, '1234$gcore-launch'), plan);
    expect(r.extId).toBe('c-1');
    const body = JSON.parse(f.log.find(h => h.init.method === 'POST').init.body);
    expect(body).toMatchObject({name: 'comp-abc123', flavor: 'bm3-ai-1xlarge-h100-80-8', servers_count: 1, image_id: 'img-1', servers_settings: {interfaces: [{type: 'external', ip_family: 'ipv4'}], credentials: {ssh_key_name: 'laptop'}, user_data: btoa('echo hi')}});
    const e = mock([['/cloud/v1/projects', 200, projects], ['/images', 200, images], ['/ssh_keys/5', 200, keys], ['/clusters', 200, {tasks: ['t2']}], ['/tasks/t2', 200, {id: 't2', state: 'ERROR', error: 'No available hosts for flavor bm3-ai-1xlarge-h100-80-8', created_resources: {ai_clusters: ['c-2']}}]]);
    expect(await kindOf(gcore.launch(ctx(e, '1234$gcore-launch2'), plan))).toBe('capacity');
    expect(e.log.some(h => h.init.method === 'DELETE' && h.url.endsWith('/clusters/c-2'))).toBe(true);
    const q = mock([['/cloud/v1/projects', 200, projects], ['/images', 200, images], ['/ssh_keys/5', 200, keys], ['/clusters', 200, {tasks: ['t3']}], ['/tasks/t3', 200, {id: 't3', state: 'ERROR', error: 'Quota exceeded: baremetal_gpu_h100_count'}]]);
    expect(await kindOf(gcore.launch(ctx(q, '1234$gcore-launch3'), plan))).toBe('quota');
  });
  it('lists clusters of both kinds for the account guard', async () => {
    const f = mock([['/cloud/v1/projects', 200, projects], ['/cloud/v1/regions', 200, regions], ['/gpu/baremetal/5/76/clusters', 200, {count: 1, results: [{id: 'c-1', name: 'comp-abc123', flavor: 'bm3-ai-1xlarge-h100-80-8'}]}], ['/gpu/virtual/5/76/clusters', 200, {count: 0, results: []}]]);
    expect(await gcore.active(ctx(f, '1234$gcore-active'), {})).toEqual([{extId: 'c-1', name: 'comp-abc123', config: 'bm:bm3-ai-1xlarge-h100-80-8', region: '76', status: 'exists'}]);
  });
});

describe('launch safety in the adapters', () => {
  it('reads the RateLimit header into a pace that keeps every window from running dry', () => {
    expect(paceOf('"minute";r=57;t=12, "hour";r=2800;t=1812, "day";r=43015;t=86000')).toBe(2000);
    expect(paceOf('"minute";r=2;t=30')).toBe(30000);
    expect(paceOf('nonsense')).toBe(0);
  });
  it('offers RunPod every allowed data center, and terminates a pod placed outside them', async () => {
    const plan = {config: 'NVIDIA H100 80GB HBM3', region: 'EU-FR-1', name: 'comp-abc123', spec: {params: {count: 8, cloud: 'SECURE'}, regions: ['EU-SE-1', 'EU-FR-1'], launch: {}}};
    const ok = mock([['/pods', 201, {id: 'pod1', name: 'comp-abc123', status: 'PROVISIONING', dataCenterId: 'EU-SE-1', cost: 35.12}]]);
    const r = await runpod.launch(ctx(ok), plan);
    expect(r).toMatchObject({extId: 'pod1', price: 35.12});
    const body = JSON.parse(ok.log[0].init.body);
    expect(body.dataCenterIds).toEqual(['EU-FR-1', 'EU-SE-1']);
    expect(body.gpu).toMatchObject({id: 'NVIDIA H100 80GB HBM3', count: 8, minCudaVersion: '12.8'});
    expect(body.image).toBe('runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404');
    const away = mock([['/pods/pod2', 200, {}], ['/pods', 201, {id: 'pod2', name: 'comp-abc123', status: 'PROVISIONING', dataCenterId: 'CA-MTL-1'}]]);
    expect(await kindOf(runpod.launch(ctx(away), plan))).toBe('capacity');
    expect(away.log.some(h => h.init.method === 'DELETE' && h.url.endsWith('/pods/pod2'))).toBe(true);
    const ms = await runpod.active(ctx(mock([['/pods', 200, {pods: [{id: 'a', name: 'x', status: 'RUNNING', gpu: {id: 'NVIDIA H100 80GB HBM3', count: 8}, dataCenterId: 'EU-SE-1'}, {id: 'b', name: 'y', status: 'TERMINATED'}], pagination: {hasNextPage: false}}]])));
    expect(ms).toEqual([{extId: 'a', name: 'x', config: 'NVIDIA H100 80GB HBM3', gpus: 8, region: 'EU-SE-1', status: 'RUNNING'}]);
  });
  it('tells the RunPod launch check about balance, spend limit and SSH keys', async () => {
    const f = mock([['/catalog/gpus', 200, {gpus: [{id: 'NVIDIA H100 80GB HBM3', name: 'H100 SXM', secure: true, maxCount: {secure: 8}, price: {secure: 4.39}}]}], ['/catalog/datacenters', 200, {dataCenters: [{id: 'EU-SE-1'}]}],
      ['/billing/balance', 200, {balanceAmount: 29.24, billingMode: 'PREPAID'}], ['/account/limits', 200, {spendRate: {limit: 80, current: 0}}], ['/account/ssh-keys', 200, {keys: []}]]);
    const out = await runpod.preflight(ctx(f), {configs: ['NVIDIA H100 80GB HBM3'], regions: ['EU-SE-1'], params: {count: 8, cloud: 'SECURE'}, launch: {}});
    const fails = out.filter(x => x.level === 'fail').map(x => x.text).join(' | ');
    expect(fails).toMatch(/Balance \$29.24 is less than one hour of the machine \(\$35.12\)/);
    expect(fails).toMatch(/No SSH public key/);
  });
  it('checks Lambda launch settings: the key, and the image in every chosen region', async () => {
    const f = mock([['/instance-types', 200, {data: {gpu_8x_h100_sxm5: {instance_type: {name: 'gpu_8x_h100_sxm5', description: '8x H100', price_cents_per_hour: 3672, architecture: 'x86_64'}, regions_with_capacity_available: []}}}],
      ['/ssh-keys', 200, {data: [{name: 'laptop'}]}], ['/images', 200, {data: [{family: 'gpu-base-24-04', architecture: 'x86_64', region: {name: 'us-west-3'}}]}]]);
    const c = Object.assign(ctx(f), {fast: true});
    const out = await lambda.preflight(c, {configs: ['gpu_8x_h100_sxm5'], regions: ['europe-central-1'], launch: {ssh_key: 'gone', image: 'gpu-base-24-04'}});
    const fails = out.filter(x => x.level === 'fail').map(x => x.text).join(' | ');
    expect(fails).toMatch(/SSH key "gone" is not in the account/);
    expect(fails).toMatch(/not offered in europe-central-1/);
  });
  it('treats Nebius RESOURCE_EXHAUSTED without a quota failure as no capacity, and a quota failure as a limit', async () => {
    const pair = await crypto.subtle.generateKey({name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256'}, true, ['sign', 'verify']) as CryptoKeyPair;
    const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey) as ArrayBuffer);
    const creds = JSON.stringify({'subject-credentials': {alg: 'RS256', 'private-key': '-----BEGIN PRIVATE KEY-----\n' + btoa(String.fromCharCode(...der)) + '\n-----END PRIVATE KEY-----', kid: 'publickey-n' + Math.random(), iss: 'serviceaccount-1', sub: 'serviceaccount-1'}});
    const plan = {config: 'gpu-h100-sxm|8gpu-128vcpu-1600gb', region: 'eu-north1', name: 'comp-abc123', spec: {launch: {ssh_keys: 'ssh-ed25519 AAAA me'}, launchId: 'mch_1'}};
    const run = (status: number, body: any) => nebius.launch(ctx(mock([['/oauth2/token/exchange', 200, {access_token: 't', expires_in: 3600}], ['/vpc/v1/subnets', 200, {items: [{metadata: {id: 'vpcsubnet-1'}}]}], ['/compute/v1/instances', status, body]]), creds, {projects: {'eu-north1': 'project-1'}}), plan);
    expect(await kindOf(run(429, {code: 8, message: 'resource exhausted'}))).toBe('capacity');
    expect(await kindOf(run(429, {code: 8, message: 'quota', details: [{quotaFailure: {violations: [{quota: 'gpu'}]}}]}))).toBe('quota');
    expect(await kindOf(run(400, {code: 9, message: 'Not enough resources'}))).toBe('capacity');
    // a create whose operation finishes with an error: a definite answer (status 1), so the engine never goes looking for a machine
    const f = mock([['/oauth2/token/exchange', 200, {access_token: 't', expires_in: 3600}], ['/vpc/v1/subnets', 200, {items: [{metadata: {id: 'vpcsubnet-1'}}]}], ['/compute/v1/instances/ci-1', 200, {}], ['/compute/v1/instances', 200, {id: 'op1', resourceId: 'ci-1', status: {code: 13, message: 'internal error'}}]]);
    try { await nebius.launch(ctx(f, creds, {projects: {'eu-north1': 'project-1'}}), plan); throw new Error('no'); }
    catch (e: any) { expect(e).toBeInstanceOf(ProviderError); expect(e.status).toBe(1); expect(e.kind).toBe('http'); }
    expect(f.log.some(h => h.init.method === 'DELETE' && h.url.endsWith('/compute/v1/instances/ci-1'))).toBe(true);
  });
});

describe('Nebius key pasted from the console', () => {
  // a throwaway 2048-bit test key in the old PKCS#1 form that openssl on a Mac writes
  const PKCS1 = '-----BEGIN RSA PRIVATE KEY-----\nMIIEogIBAAKCAQEAvk2yrZJnThze3mWMdAA27uulyHdmLeWG9SHDReQ57zyPjxH3\nJpfGxi2YLRt92pC/fps6C/fn0Amewct1Gu6nbcWSrztC1mHN26fJrxE5Km4KIf1o\nf80W381XL9VzC/t6sgWy2PH3xYP3s/PvyTkjhx025d1LVVhH+h/Gc5XJ28C9v0rX\nZb4BUSamw7rj1FwXm0HWZKQ5ssNaWmjWL4rNo8BV+xIWC0TmJXHelGIoolzJdZfw\nbNZ5cYEikVVbuZuBMZPEdYljZn5pXB2JPJfKwKla3BuXBPYNoDqLqu1WOvCMFVMC\nFSe7LvE1jw+HW0sUayTsbsF7uRTfi2YgGCFzcQIDAQABAoIBAA04tjmHcqxzZouS\niBXWHvrt/dRl8UAukngM+rVsJBdKQJoa0C5K/LkvmUNHBfEtvdQ0wi1rMZybUn+Z\n3F685n6Cq8yHZD8jR+tjJqjGXE+lmggfBEfezqBJcq2E2aujMvTT3wdiFkoPf2Hu\nCIKVOPHt9m61d4KsMcH/u6izpzTgejhlDxOdvL2NdZnOmqfR2S7lfV4XbE6jULnF\ndp8eDx34ELXzfKiruUjcXJ4yKbELVJJVWLLLjIjmlyIqG5fOtytZJX1dScirOaq6\nR3/AeM9BsLjoFuqEFoMeQJfI5jiCYQ9Zrey9uxpA5MX5sCJigEMeOmGNyMVQfvxT\nS1yzx00CgYEA75ls/JNZkBvUPfltumvJrGAHpvIVOv0/0T3hcGpDwFW9SyIY+Joc\n6ugQajN41j2Tr++7ISEcQ+AljE1RefIs4tM/1S1ay/DHQXfK5Mq19rmulPzHRavR\nN3z6IynTr9UVzUp01A1qWkZLuihzV1Y8JDd/KQZXRSTbuVUZ6MD+UrUCgYEAy1Ry\nOvuAk30GGvY6hpbbl/xRQ6tbLTPXX2OAIvyMmfXino9dhi170DIkTHFI6INXgeu+\niBSoEpl9NO2n/4asXhK+4Yx6X2hHCou7RpeGhIdA8O8nH70xipqSPms6yyGNH+8T\nk6UPAonTWEvrjhd9+LobU6z/lLvfvKX4WSGFJ00CgYAYNap7gvADzawObwuVUJra\nHgHn7oISqdAu9k+3KiWaY49y7gkT5Y6Sdcxizryg+SvZFSIVYOEYQqfIm29mIQBE\nExBaG/EWtkeL5+zKXWkxeuWXDEueUJQdRTWJJArNs3w2eBWB77EVWhEAyGGPK5l8\nF1dz774VsHm7Kkwp5oZMGQKBgBw5P5XyXTmbzCIn9Z3DCP5C1uDmw0Q2AvpJrHqu\nxbGFUQyjZ979J0eR/jniK7WirZ3qJEttWpsiVR/osT4l6n0wavCR+FaP+fR7yuYU\nmGaDA7+t4qdkMqFDrXMenU2e/aDmJbiD296FVSHXf/38Qs8ovixSQjPaFEdyXlO4\n9GutAoGAecostNWkqCjFfr1vpOjZxX237PL88dEwUQ/PjYlul5eD0hViKafJ4bTA\nprEhOjCUbnpXt+7ol2RTRW2md7i6NjBvSMpxcp7vxBEe7IrlMHJYBJ4FWkW1ebvo\nt2U7p2TMZdiQ/y85Cjr7DyYA+JN87yu/ao6ogK/6YbWnsBuZTsk=\n-----END RSA PRIVATE KEY-----';
  it('takes the service account ID, the key ID and a PKCS#1 private key pasted one under another', async () => {
    const pasted = 'serviceaccount-e00abc123\npublickey-e00def456\n' + PKCS1;
    expect(readCreds(pasted)).toMatchObject({iss: 'serviceaccount-e00abc123', sub: 'serviceaccount-e00abc123', kid: 'publickey-e00def456'});
    const f = mock([['/oauth2/token/exchange', 200, {access_token: 't', expires_in: 3600}], ['/compute/v1/instances/ci-1', 200, {metadata: {id: 'ci-1'}, status: {state: 'RUNNING'}}]]);
    await nebius.instance(ctx(f, pasted), 'ci-1');
    const jwt = new URLSearchParams(String(f.log[0].init.body)).get('subject_token');
    expect(JSON.parse(atob(jwt.split('.')[0].replace(/-/g, '+').replace(/_/g, '/')))).toMatchObject({alg: 'RS256', kid: 'publickey-e00def456'});
    expect(() => readCreds('serviceaccount-e00abc123\n' + PKCS1)).toThrow(/authorized key ID/);
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
/* the engine runs one turn at a time (alarm() holds `busy`); a test turn waits for any alarm turn the API's poke started, and holds it too */
const endAll = () => E.DB.prepare("UPDATE launches SET state = 'ended' WHERE state IN ('created', 'unknown')").run();
const solo = async (w: any, fn: () => Promise<void>) => { while (w.busy) await new Promise(r => setTimeout(r, 20)); w.busy = true; try { w.keyNext = 0; w.guardList = null; w.guardAt = 0; for (const r of w.runs.values()) { r.reconAt = 0; r.holdUntil = 0; } await fn(); } finally { w.busy = false; } };
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
    // a started machine cannot be forgotten while it may still run
    expect((await api('DELETE', '/launches/' + m.data.items[0].id)).data.error).toBe('still_running');
    await endAll();
  });
  it('stops on a refusal that would only repeat, and tells why', async () => {
    await endAll();
    const r = await api('POST', '/watches', {keyId, name: 'Refused', mode: 'launch', every: 5, spec: {configs: ['fake_1x_a100'], launch: {ssh_key: 'laptop', fail: 'quota'}}});
    const stub = E.WATCHER.get(E.WATCHER.idFromName(keyId));
    await runInDurableObject(stub, async (w: any) => { w.loadedAt = 0; w.launchNext = 0; await w.tick(Date.now()); });
    const wr = await E.DB.prepare('SELECT state, stop_reason FROM watches WHERE id = ?').bind(r.data.id).first();
    expect(wr.state).toBe('stopped'); expect(wr.stop_reason).toMatch(/account may not/);
    expect((await E.DB.prepare("SELECT state FROM launches WHERE watch_id = ?").bind(r.data.id).first('state'))).toBe('failed');
  });
  it('settles an unclear launch by name and never starts a second machine', async () => {
    const mk = async (fail: string, extra: any = {}) => (await api('POST', '/watches', {keyId, name: 'Unclear ' + fail, mode: 'launch', every: 5, maxLaunch: 1, spec: {configs: ['fake_1x_a100'], regions: ['test-east-1'], launch: {ssh_key: 'laptop', fail}, ...extra}})).data.id;
    const run = async () => { const stub = E.WATCHER.get(E.WATCHER.idFromName(keyId)); await runInDurableObject(stub, async (w: any) => { await solo(w, async () => { w.loadedAt = 0; w.launchNext = 0; for (const r of w.runs.values()) r.next = 0; await w.tick(Date.now()); }); }); };
    const state = async (id: string) => ({w: await E.DB.prepare('SELECT state, launched, stop_reason FROM watches WHERE id = ?').bind(id).first(), l: (await E.DB.prepare('SELECT state, ext_id, name FROM launches WHERE watch_id = ?').bind(id).all()).results});
    // timed out, but the machine exists: found by name and counted, nothing more is started
    await endAll();
    const a = await mk('timeout_made'); await run();
    let s = await state(a);
    expect(s.l).toHaveLength(1); expect(s.l[0].state).toBe('created'); expect(s.l[0].ext_id).toBe(MADE.get(s.l[0].name).id);
    expect(s.w).toMatchObject({state: 'done', launched: 1});
    // timed out and nothing there: unknown, the watch stops, and it cannot be resumed until the launch is deleted
    MADE.clear(); await endAll();
    const b = await mk('timeout'); await run();
    s = await state(b);
    expect(s.l).toHaveLength(1); expect(s.l[0].state).toBe('unknown'); expect(s.w).toMatchObject({state: 'stopped'});
    expect((await api('PATCH', '/watches/' + b, {state: 'on'})).data.error).toBe('launch_unknown');
    const lid = (await E.DB.prepare('SELECT id FROM launches WHERE watch_id = ?').bind(b).first('id'));
    expect((await api('DELETE', '/launches/' + lid)).status).toBe(200);
    expect((await api('PATCH', '/watches/' + b, {state: 'paused'})).status).toBe(200);
    // a server error with no machine behind it: failed, and the watch keeps hunting
    MADE.clear();
    const c5 = await mk('5xx'); await run();
    s = await state(c5);
    expect(s.l).toHaveLength(1); expect(s.l[0].state).toBe('failed'); expect(s.w.state).toBe('on');
    await E.DB.prepare("UPDATE watches SET state = 'paused' WHERE id IN (?, ?)").bind(c5, a).run();
  });
  it('picks up a launch a restart interrupted', async () => {
    await endAll();
    const id = (await api('POST', '/watches', {keyId, name: 'Interrupted', mode: 'launch', every: 5, maxLaunch: 1, paused: true, spec: {configs: ['fake_1x_a100'], regions: ['test-east-1'], launch: {ssh_key: 'laptop'}}})).data.id;
    const old = Date.now() - 10 * 60e3, u = (await E.DB.prepare('SELECT user_id FROM watches WHERE id = ?').bind(id).first('user_id'));
    MADE.set('apicheck-left01', {id: 'test-left01', config: 'fake_1x_a100', region: 'test-east-1', secret: 'elsewhere'});
    await E.DB.prepare("INSERT INTO launches (id, user_id, watch_id, key_id, provider, target, region, name, state, created_at, updated_at) VALUES ('mch_left01', ?, ?, ?, 'fake', 'fake_1x_a100', 'test-east-1', 'apicheck-left01', 'pending', ?, ?)").bind(u, id, keyId, old, old).run();
    await E.DB.prepare("UPDATE watches SET state = 'on' WHERE id = ?").bind(id).run();
    const stub = E.WATCHER.get(E.WATCHER.idFromName(keyId));
    await runInDurableObject(stub, async (w: any) => { await solo(w, async () => { w.loadedAt = 0; w.launchNext = 0; for (const r of w.runs.values()) r.next = 0; await w.tick(Date.now()); }); });
    const l = (await E.DB.prepare('SELECT state, ext_id FROM launches WHERE watch_id = ?').bind(id).all()).results;
    expect(l).toEqual([{state: 'created', ext_id: 'test-left01'}]);
    expect(await E.DB.prepare('SELECT state FROM watches WHERE id = ?').bind(id).first('state')).toBe('done');
  });
  it('lets a group of watches on different keys start one machine in total', async () => {
    MADE.clear(); await endAll();
    const k2 = (await api('POST', '/keys', {provider: 'fake', label: 'Second', key: 'test-key-value-second'})).data.id;
    const body = (k: string, n: string) => ({keyId: k, name: n, mode: 'launch', every: 5, maxLaunch: 1, paused: true, spec: {configs: ['fake_1x_a100'], regions: ['test-east-1'], launch: {ssh_key: 'laptop'}, group: 'Competition'}});
    const w1 = (await api('POST', '/watches', body(keyId, 'Group one'))).data.id, w2 = (await api('POST', '/watches', body(k2, 'Group two'))).data.id;
    expect((await E.DB.prepare('SELECT spec FROM watches WHERE id = ?').bind(w1).first('spec'))).toContain('"group":"competition"');
    await E.DB.prepare("UPDATE watches SET state = 'on' WHERE id IN (?, ?)").bind(w1, w2).run();
    for (const k of [keyId, k2]) await runInDurableObject(E.WATCHER.get(E.WATCHER.idFromName(k)), async (w: any) => { await solo(w, async () => { w.keyId = k; w.loadedAt = 0; w.launchNext = 0; for (const r of w.runs.values()) r.next = 0; await w.tick(Date.now()); }); });
    const n = await E.DB.prepare("SELECT COUNT(*) AS n FROM launches WHERE watch_id IN (?, ?) AND state IN ('pending', 'created', 'unknown')").bind(w1, w2).first('n');
    expect(n).toBe(1);
    const st = (await E.DB.prepare('SELECT id, state, stop_reason FROM watches WHERE id IN (?, ?)').bind(w1, w2).all()).results;
    expect(st.every((x: any) => x.state === 'done')).toBe(true);
    expect(st.find((x: any) => x.id === w1).stop_reason).toMatch(/Started 1 of 1/);
    expect(st.find((x: any) => x.id === w2).stop_reason).toMatch(/group "competition"/);
  });
  it('does not start a machine while the account already runs one of this kind', async () => {
    MADE.clear(); await endAll();
    MADE.set('by-hand', {id: 'test-byhand', config: 'fake_1x_a100', region: 'test-east-1', secret: 'test-key-value-123456'});
    const id = (await api('POST', '/watches', {keyId, name: 'Guarded', mode: 'launch', every: 5, maxLaunch: 1, paused: true, spec: {configs: ['fake_1x_a100'], regions: ['test-east-1'], launch: {ssh_key: 'laptop'}}})).data.id;
    await E.DB.prepare("UPDATE watches SET state = 'on' WHERE id = ?").bind(id).run();
    const tick = () => runInDurableObject(E.WATCHER.get(E.WATCHER.idFromName(keyId)), async (w: any) => { await solo(w, async () => { w.loadedAt = 0; w.launchNext = 0; for (const r of w.runs.values()) r.next = 0; await w.tick(Date.now()); }); });
    await tick();
    expect(await E.DB.prepare('SELECT COUNT(*) AS n FROM launches WHERE watch_id = ?').bind(id).first('n')).toBe(0);
    const wr = await E.DB.prepare('SELECT state, stop_reason FROM watches WHERE id = ?').bind(id).first();
    expect(wr.state).toBe('stopped'); expect(wr.stop_reason).toMatch(/already runs by-hand/);
    // with the guard off, a machine started by hand does not count; one API Check started under this name always does
    await E.DB.prepare("UPDATE watches SET state = 'on', spec = json_set(spec, '$.guard', json('false')) WHERE id = ?").bind(id).run();
    MADE.set('apicheck-0a1b2c', {id: 'test-ours', config: 'fake_8x_h100', region: 'test-east-1', secret: 'test-key-value-123456'});
    await tick();
    expect((await E.DB.prepare('SELECT stop_reason FROM watches WHERE id = ?').bind(id).first('stop_reason'))).toMatch(/apicheck-0a1b2c/);
    MADE.delete('apicheck-0a1b2c');
    await E.DB.prepare("UPDATE watches SET state = 'on' WHERE id = ?").bind(id).run();
    await tick();
    expect(await E.DB.prepare("SELECT COUNT(*) AS n FROM launches WHERE watch_id = ? AND state = 'created'").bind(id).first('n')).toBe(1);
    MADE.clear();
  });
  it('waits, instead of giving up, while another launch of its group is in flight', async () => {
    MADE.clear(); await endAll();
    const id = (await api('POST', '/watches', {keyId, name: 'Waits', mode: 'launch', every: 5, maxLaunch: 1, paused: true, spec: {configs: ['fake_1x_a100'], regions: ['test-east-1'], launch: {ssh_key: 'laptop'}, group: 'main'}})).data.id;
    const u = await E.DB.prepare('SELECT user_id FROM watches WHERE id = ?').bind(id).first('user_id');
    await E.DB.prepare("INSERT INTO launches (id, user_id, watch_id, key_id, provider, target, region, name, state, grp, created_at, updated_at) VALUES ('mch_sibling', ?, NULL, NULL, 'nebius', 'x', 'eu-north1', 'sib-000000', 'pending', 'main', ?, ?)").bind(u, Date.now(), Date.now()).run();
    await E.DB.prepare("UPDATE watches SET state = 'on' WHERE id = ?").bind(id).run();
    await runInDurableObject(E.WATCHER.get(E.WATCHER.idFromName(keyId)), async (w: any) => { await solo(w, async () => { w.loadedAt = 0; w.launchNext = 0; for (const r of w.runs.values()) r.next = 0; await w.tick(Date.now()); }); });
    expect(await E.DB.prepare('SELECT state FROM watches WHERE id = ?').bind(id).first('state')).toBe('on');
    expect(await E.DB.prepare('SELECT COUNT(*) AS n FROM launches WHERE watch_id = ?').bind(id).first('n')).toBe(0);
    // the sibling's launch fails: the place is free again, and this watch starts its machine
    await E.DB.prepare("UPDATE launches SET state = 'failed' WHERE id = 'mch_sibling'").run();
    await runInDurableObject(E.WATCHER.get(E.WATCHER.idFromName(keyId)), async (w: any) => { await solo(w, async () => { w.loadedAt = 0; w.launchNext = 0; for (const r of w.runs.values()) { r.next = 0; r.holdUntil = 0; } await w.tick(Date.now()); }); });
    expect(await E.DB.prepare("SELECT COUNT(*) AS n FROM launches WHERE watch_id = ? AND state = 'created'").bind(id).first('n')).toBe(1);
    // and the group now has its machine: a second watch of the group, on the same provider, gives up for good
    const id2 = (await api('POST', '/watches', {keyId, name: 'Too late', mode: 'launch', every: 5, maxLaunch: 1, paused: true, spec: {configs: ['fake_1x_a100'], regions: ['test-east-1'], launch: {ssh_key: 'laptop', name: 'late'}, group: 'main', guard: false}})).data.id;
    await E.DB.prepare("UPDATE watches SET state = 'on' WHERE id = ?").bind(id2).run();
    await runInDurableObject(E.WATCHER.get(E.WATCHER.idFromName(keyId)), async (w: any) => { await solo(w, async () => { w.loadedAt = 0; w.launchNext = 0; for (const r of w.runs.values()) { r.next = 0; r.holdUntil = 0; } await w.tick(Date.now()); }); });
    expect(await E.DB.prepare('SELECT state, stop_reason FROM watches WHERE id = ?').bind(id2).first()).toMatchObject({state: 'done', stop_reason: expect.stringMatching(/group "main" already has its machine/)});
    MADE.clear(); await endAll();
  });
  it('never starts a second machine at one provider, whatever the watch allows', async () => {
    MADE.clear(); await endAll();
    const id = (await api('POST', '/watches', {keyId, name: 'Two allowed', mode: 'launch', every: 5, maxLaunch: 2, paused: true, spec: {configs: ['fake_1x_a100'], regions: ['test-east-1'], launch: {ssh_key: 'laptop'}, guard: false}})).data.id;
    await E.DB.prepare("UPDATE watches SET state = 'on' WHERE id = ?").bind(id).run();
    for (let i = 0; i < 2; i++) await runInDurableObject(E.WATCHER.get(E.WATCHER.idFromName(keyId)), async (w: any) => { await solo(w, async () => { w.loadedAt = 0; w.launchNext = 0; for (const r of w.runs.values()) { r.next = 0; r.holdUntil = 0; } await w.tick(Date.now()); }); });
    expect(await E.DB.prepare("SELECT COUNT(*) AS n FROM launches WHERE watch_id = ? AND state = 'created'").bind(id).first('n')).toBe(1);
    expect(await E.DB.prepare('SELECT stop_reason FROM watches WHERE id = ?').bind(id).first('stop_reason')).toMatch(/one machine per provider/);
    MADE.clear(); await endAll();
  });
  it('checks launch settings with reads only, and says what would fail', async () => {
    const before = await E.DB.prepare('SELECT COUNT(*) AS n FROM launches').first('n');
    const good = await api('POST', `/keys/${keyId}/preflight`, {spec: {configs: ['fake_1x_a100'], regions: ['test-east-1'], launch: {ssh_key: 'laptop'}}});
    expect(good.status).toBe(200); expect(good.data.checks.some((x: any) => x.level === 'fail')).toBe(false);
    const bad = await api('POST', `/keys/${keyId}/preflight`, {spec: {configs: ['fake_1x_a100'], launch: {ssh_key: 'laptop', fail: 'preflight'}}});
    expect(bad.data.checks[0]).toMatchObject({level: 'fail'});
    expect((await api('POST', `/keys/${keyId}/preflight`, {spec: {configs: ['fake_1x_a100'], launch: {}}})).data).toMatchObject({error: 'launch_field', field: 'ssh_key'});
    expect(await E.DB.prepare('SELECT COUNT(*) AS n FROM launches').first('n')).toBe(before);
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
  it('tells search engines to stay out of every API answer', async () => {
    const res = await SELF.fetch(ORIGIN + '/api/auth/state');
    expect(res.headers.get('x-robots-tag')).toMatch(/noindex/);
  });
  it('refuses writes without the CSRF header', async () => {
    const res = await SELF.fetch(ORIGIN + '/api/keys', {method: 'POST', headers: {cookie, 'content-type': 'application/json'}, body: '{}'});
    expect(res.status).toBe(403);
  });
});
