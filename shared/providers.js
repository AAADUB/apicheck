// What each provider needs and offers, in one place: the browser builds its forms from this, the Worker checks requests against it.
// Field types: text | textarea | number | select (from a catalogue list, or fixed choices) | toggle | secret.

/* seconds between checks: the floor each provider's rate limits allow, and a sensible default; launchGap = least time between launch requests, ms */
export const LIMITS = {
  lambda: {min: 2, def: 2, launchGap: 12500},     // 1 request/s in general, 1 launch per 12 s (Lambda OpenAPI 1.10.0)
  upcloud: {min: 15, def: 20, launchGap: 20000},
  nebius: {min: 5, def: 5, launchGap: 5000},      // no published limit; a 429 backs off
  runpod: {min: 2, def: 2, launchGap: 0},         // per-user minute/hour/day quotas; the engine paces itself from the RateLimit header
  hyperstack: {min: 5, def: 10, launchGap: 5000},
  fake: {min: 2, def: 5, launchGap: 0}
};
export const EVERY_MAX = 3600;
/** which regions are in Europe, by each provider's own naming (checked against the region lists of 20.11.2026) */
export const EUROPE = {
  lambda: /^europe-/,                    // europe-central-1 (Germany), europe-south-1
  runpod: /^EUR?-/,                      // EU-RO-1, EU-SE-1, EU-CZ-1, EU-NL-1, EU-FR-1, EUR-IS-1…, EUR-NO-1
  nebius: /^(eu|uk)-/,                   // eu-north1 (Finland), eu-west1/2 (France), eu-south1 (Madrid), uk-south1/2
  hyperstack: /^(NORWAY|SWEDEN|FINLAND|ICELAND|UK|GERMANY|NETHERLANDS|FRANCE|SPAIN|ITALY|POLAND)-/i,
  upcloud: /^(de|fi|nl|pl|es|se|uk|dk|no|fr|it|at|ch|ie|be|cz)-/,
  fake: /^test-east/
};
export const inEurope = (provider, region) => !!(EUROPE[provider] && EUROPE[provider].test(region));
const RANK = {none: 0, low: 1, medium: 2, yes: 2, high: 3};
export const levelRank = l => RANK[l] ?? 0;
export const LEVEL_NAME = {high: 'High', medium: 'Medium', low: 'Low', yes: 'Available', none: 'None'};

export const PROVIDERS = {
  lambda: {
    name: 'Lambda', short: 'L', site: 'https://cloud.lambda.ai',
    keyHelp: 'An API key from the Lambda console: Settings, API keys. Lambda keys cannot be limited in scope, so this key can do anything your account can.',
    keyFields: [{id: 'key', label: 'API key', type: 'secret', ph: 'secret_…'}],
    signal: 'exact',
    signalText: 'Lambda reports, for every machine type, the regions where it can be started right now. API Check reads that list on every check.',
    regionsLabel: 'Regions',
    launch: [
      {id: 'ssh_key', label: 'SSH key', type: 'select', from: 'sshKeys', required: true, help: 'Lambda puts exactly one of your saved keys on the machine.'},
      {id: 'image', label: 'Image', type: 'select', from: 'images', empty: 'Lambda Stack (default)', help: 'The operating system and drivers. GH200 machines need an Arm image.'},
      {id: 'filesystem', label: 'Filesystem', type: 'select', from: 'filesystems', empty: 'None', regionBound: true, help: 'Shared storage mounted at /lambda/nfs/<name>. A filesystem lives in one region, so choosing one limits the watch to that region.'},
      {id: 'firewall', label: 'Firewall ruleset', type: 'select', from: 'firewalls', empty: 'Account default (SSH only)', regionBound: true},
      {id: 'name', label: 'Machine name', type: 'text', max: 60, ph: 'apicheck-…'},
      {id: 'hostname', label: 'Hostname', type: 'text', max: 63, pattern: '^[a-z0-9][0-9a-z-]{0,62}$'},
      {id: 'user_data', label: 'Startup script (cloud-init)', type: 'textarea', max: 60000, code: true, help: 'Runs once on first boot: install Docker, pull your models, start services.'}
    ],
    notes: ['New Lambda accounts have an instance limit that grows as invoices are paid. Ask Lambda support to confirm an 8-GPU machine is allowed before you rely on a watch.', 'Lambda bills by the minute from when the machine passes health checks until you terminate it. There is no stop.']
  },
  upcloud: {
    name: 'UpCloud', short: 'U', site: 'https://hub.upcloud.com',
    keyHelp: 'An API token (Account, API tokens). UpCloud tokens can be limited to IP ranges; API Check runs on Cloudflare, whose addresses change, so leave the token open to all addresses and give it an end date instead. An API sub-account as user:password also works.',
    keyFields: [{id: 'key', label: 'API token', type: 'secret', ph: 'ucat_…'}],
    signal: 'count',
    signalText: 'UpCloud reports, per zone, how many units of each GPU plan are free (the same list as "upctl zone devices"). UpCloud does not document exactly what the number counts, so API Check shows it as is and treats 1 or more as available.',
    regionsLabel: 'Zones',
    launch: [
      {id: 'template', label: 'Operating system', type: 'select', from: 'templates', required: true, help: 'The AI/ML template comes with NVIDIA drivers, CUDA, Docker and the NVIDIA Container Toolkit.'},
      {id: 'ssh_keys', label: 'SSH public keys', type: 'textarea', required: true, max: 8000, code: true, help: 'One per line. Cloud-init templates allow key login only.'},
      {id: 'username', label: 'User name', type: 'text', max: 32, pattern: '^[a-z_][a-z0-9_-]{0,31}$', help: 'Empty: root.'},
      {id: 'disk_size', label: 'System disk, GB', type: 'number', min: 10, max: 1024, int: true, def: 200, help: 'GPU plans include no disk. Up to 1024 GB here; add more disks later in the hub.'},
      {id: 'disk_tier', label: 'Disk tier', type: 'select', choices: [['maxiops', 'MaxIOPS'], ['standard', 'Standard']], def: 'maxiops'},
      {id: 'name', label: 'Server title', type: 'text', max: 60, ph: 'apicheck-…'},
      {id: 'hostname', label: 'Hostname', type: 'text', max: 60, pattern: '^[a-z0-9][a-z0-9.-]{0,59}$'},
      {id: 'user_data', label: 'Startup script (cloud-init or shell)', type: 'textarea', max: 60000, code: true}
    ],
    notes: ['Each account may run a limited number of GPUs, set by UpCloud from the account history. Ask support to raise it to the plan you watch for, or the launch will be refused.', 'Promotional credits cannot pay for GPU servers. GPU servers bill by the started hour while on; disks and IPv4 bill even when off.', 'Shared file storage (NFS) needs a private SDN network and is set up in the hub, not here.']
  },
  nebius: {
    name: 'Nebius', short: 'N', site: 'https://console.nebius.com',
    keyHelp: 'A service account key. In the console create a service account, give it the editor role in your tenant (viewer is enough to watch), then run: nebius iam auth-public-key generate --service-account-id <id> --output credentials.json, and paste the file here.',
    keyFields: [{id: 'key', label: 'Credentials file (JSON)', type: 'textarea', code: true, ph: '{"subject-credentials": {"alg": "RS256", "private-key": "-----BEGIN PRIVATE KEY-----…", "kid": "publickey-…", "iss": "serviceaccount-…", "sub": "serviceaccount-…"}}'}],
    signal: 'level',
    signalText: 'Nebius reports a chance of launch (high, medium, low) for every platform, preset and region, with your quota already taken into account (the capacity advisor). It is a forecast, refreshed by Nebius on its own schedule, not a reservation.',
    regionsLabel: 'Regions',
    launch: [
      {id: 'ssh_keys', label: 'SSH public keys', type: 'textarea', max: 8000, code: true, help: 'One per line. They go into the cloud-init that creates the user below. Not needed if you write your own cloud-init.'},
      {id: 'username', label: 'User name', type: 'text', max: 32, def: 'ubuntu', pattern: '^[a-z_][a-z0-9_-]{0,31}$'},
      {id: 'image', label: 'Image', type: 'select', from: 'images', def: 'ubuntu24.04-cuda13.0'},
      {id: 'disk_size', label: 'Boot disk, GiB', type: 'number', min: 50, max: 4096, int: true, def: 200},
      {id: 'subnet', label: 'Subnet', type: 'select', from: 'subnets', empty: 'The first subnet of the region', regionBound: true},
      {id: 'filesystem', label: 'Shared filesystem', type: 'select', from: 'filesystems', empty: 'None', regionBound: true, help: 'Mounted at /mnt/data by the generated cloud-init. A filesystem lives in one region.'},
      {id: 'public_ip', label: 'Public IP address', type: 'toggle', def: true},
      {id: 'name', label: 'Machine name', type: 'text', max: 50, pattern: '^[a-z0-9][a-z0-9-]*$', ph: 'apicheck-…'},
      {id: 'user_data', label: 'Your own cloud-init (replaces the generated one)', type: 'textarea', max: 32000, code: true}
    ],
    notes: ['A single 8-GPU machine needs no GPU cluster; clusters are for InfiniBand between machines and limit where a machine can be placed.', 'Nebius bills by the second while the machine runs; disks bill by size. A failed launch is deleted with its boot disk at once.']
  },
  runpod: {
    name: 'RunPod', short: 'R', site: 'https://console.runpod.io',
    keyHelp: 'An API key from Settings, API Keys, with read and write access to Pods and read access to the catalogue (billing and account read are useful too: they show your balance and spend limit).',
    keyFields: [{id: 'key', label: 'API key', type: 'secret', ph: 'rpa_…'}],
    signal: 'level',
    signalText: 'RunPod reports stock (high, medium, low) for each GPU type, for the number of GPUs you ask for, per data center.',
    regionsLabel: 'Data centers',
    launch: [
      {id: 'image', label: 'Container image', type: 'text', max: 300, def: 'runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404', help: 'Ignored when a template is chosen.'},
      {id: 'template', label: 'Template', type: 'select', from: 'templates', empty: 'None: use the image above'},
      {id: 'disk', label: 'Container disk, GB', type: 'number', min: 10, max: 4000, int: true, def: 200, help: 'Wiped on restart. Keep data on a network volume.'},
      {id: 'network_volume', label: 'Network volume', type: 'select', from: 'networkVolumes', empty: 'None', regionBound: true, help: 'Persistent storage. It lives in one data center and works on Secure Cloud only.'},
      {id: 'volume_path', label: 'Volume mount path', type: 'text', max: 100, def: '/workspace'},
      {id: 'ports', label: 'Ports', type: 'text', max: 200, def: '22/tcp,8888/http', help: 'Comma separated. 22/tcp gives direct SSH.'},
      {id: 'start_ssh', label: 'Put my RunPod SSH keys on the pod', type: 'toggle', def: true},
      {id: 'min_cuda', label: 'Minimum CUDA on the host', type: 'select', choices: [['', 'Any'], ['12.4', '12.4'], ['12.6', '12.6'], ['12.8', '12.8'], ['13.0', '13.0']]},
      {id: 'min_ram', label: 'Minimum RAM per GPU, GB', type: 'number', min: 1, max: 4096, int: true, help: 'Skips smaller machines; it does not add memory.'},
      {id: 'min_vcpu', label: 'Minimum vCPU per GPU', type: 'number', min: 1, max: 256, int: true},
      {id: 'env', label: 'Environment variables', type: 'textarea', max: 8000, code: true, ph: 'HF_TOKEN=…', help: 'One KEY=value per line.'},
      {id: 'start_cmd', label: 'Start command', type: 'text', max: 2000},
      {id: 'name', label: 'Pod name', type: 'text', max: 60, ph: 'apicheck-…'}
    ],
    notes: ['RunPod needs at least one hour of the pod\'s price in credit to start it, and has a spend limit per hour across everything running ($80 by default).', 'Stopping a pod releases its GPUs; a stopped 8-GPU pod may not get them back. Terminate and keep data on a network volume instead.', 'RunPod also has its own "deploy when available" queue (retries about every five minutes). API Check checks more often and does not use it, so two machines are never started by two mechanisms.']
  },
  hyperstack: {
    name: 'Hyperstack', short: 'H', site: 'https://console.hyperstack.cloud',
    keyHelp: 'An API key from the Hyperstack console: API Keys. A Hyperstack key can do anything your account can. To start machines you also need, in each region you want, an environment with your SSH key in it (Environments, then SSH keys).',
    keyFields: [{id: 'key', label: 'API key', type: 'secret', ph: 'API key'}],
    signal: 'exact',
    signalText: 'Hyperstack marks every flavor in every region as in stock or not, and reports how many machines of each GPU count can be deployed now. API Check reads both on every check.',
    regionsLabel: 'Regions',
    launch: [
      {id: 'environment', label: 'Environment', type: 'select', from: 'environments', empty: 'The first of mine in the region with an SSH key', regionBound: true, help: 'An environment lives in one region, so choosing one limits the watch to that region.'},
      {id: 'keypair', label: 'SSH key', type: 'select', from: 'keypairs', empty: 'The first key in that environment', help: 'Hyperstack keeps SSH keys per environment.'},
      {id: 'image', label: 'Image', type: 'select', from: 'images', empty: 'Newest Ubuntu with CUDA (and Docker, if there is one)', regionBound: true, help: 'Images belong to a region.'},
      {id: 'public_ip', label: 'Public IP address', type: 'toggle', def: true},
      {id: 'open_ssh', label: 'Open port 22 (SSH) to the internet', type: 'toggle', def: true, help: 'Hyperstack blocks all incoming traffic until a rule allows it.'},
      {id: 'name', label: 'Machine name', type: 'text', max: 40, pattern: '^[A-Za-z0-9][A-Za-z0-9-]*$', ph: 'apicheck-…'},
      {id: 'user_data', label: 'Startup script (cloud-init)', type: 'textarea', max: 60000, code: true}
    ],
    notes: ['The 8x H100 SXM5 flavor is sold in CANADA-1 and US-1, with different memory and local disk in each. H200 and B200 8x machines are in CANADA-1.', 'Hyperstack does not document an error code for "no capacity". A refused launch that is not about the request, the balance or a limit is treated as capacity, and the hunt goes on.', 'A machine that goes into ERROR right after it is accepted is deleted at once, and the hunt goes on.']
  }
};
export const DEV_PROVIDER = {
  fake: {name: 'Test provider', short: 'T', site: '', keyHelp: 'Any key that starts with "test". Nothing is real and nothing costs money.', keyFields: [{id: 'key', label: 'Key', type: 'secret', ph: 'test-…'}], signal: 'level',
    signalText: 'Capacity comes and goes every minute: east for 20 seconds, west for 10.', regionsLabel: 'Regions',
    launch: [{id: 'ssh_key', label: 'SSH key', type: 'select', from: 'sshKeys', required: true}, {id: 'name', label: 'Machine name', type: 'text', max: 60}, {id: 'fail', label: 'Make the launch fail', type: 'select', choices: [['', 'No'], ['quota', 'With an account limit'], ['timeout_made', 'Time out, machine made'], ['timeout', 'Time out, nothing made'], ['5xx', 'Server error, nothing made'], ['preflight', 'Refused by the launch check']]}], notes: []}
};
/* settings that change what the provider is asked about, chosen before the configuration list loads */
export const PARAMS = {
  runpod: [
    {id: 'count', label: 'GPUs per machine', choices: [[1, '1'], [2, '2'], [4, '4'], [8, '8']], def: 8},
    {id: 'cloud', label: 'Cloud', choices: [['SECURE', 'Secure Cloud'], ['COMMUNITY', 'Community Cloud']], def: 'SECURE'}
  ],
  nebius: [{id: 'kind', label: 'Pricing', choices: [['on_demand', 'On demand'], ['preemptible', 'Preemptible (spot)']], def: 'on_demand'}]
};
export const providerOf = (id, dev) => PROVIDERS[id] || (dev ? DEV_PROVIDER[id] : null);

/* the launch settings, cleaned to what the provider form allows; throws a field id when one is wrong */
export function cleanLaunch(provider, raw, dev) {
  const P = providerOf(provider, dev), out = {};
  if (!P) throw Object.assign(new Error('provider'), {field: 'provider'});
  for (const f of P.launch) {
    let v = raw ? raw[f.id] : undefined;
    if (f.type === 'toggle') { out[f.id] = v === undefined ? f.def !== false && f.def != null ? !!f.def : false : !!v; continue; }
    if (f.type === 'number') {
      if (v === '' || v == null) { if (f.def != null) out[f.id] = f.def; else if (f.required) throw Object.assign(new Error(f.id), {field: f.id}); continue; }
      const n = Number(v); if (!Number.isFinite(n) || (f.min != null && n < f.min) || (f.max != null && n > f.max) || (f.int && !Number.isInteger(n))) throw Object.assign(new Error(f.id), {field: f.id});
      out[f.id] = n; continue;
    }
    v = v == null ? '' : String(v);
    if (f.type !== 'textarea') v = v.trim();
    if (!v) { if (f.required) throw Object.assign(new Error(f.id), {field: f.id}); if (f.def != null) out[f.id] = f.def; continue; }
    if (v.length > (f.max || 500)) throw Object.assign(new Error(f.id), {field: f.id});
    if (f.pattern && !new RegExp(f.pattern).test(v)) throw Object.assign(new Error(f.id), {field: f.id});
    if (f.choices && !f.choices.some(c => c[0] === v)) throw Object.assign(new Error(f.id), {field: f.id});
    out[f.id] = v;
    if (f.regionBound && raw && raw[f.id + '_region']) out[f.id + '_region'] = String(raw[f.id + '_region']).slice(0, 100);
  }
  return out;
}
