// A pretend provider for development and tests: never reaches the network, never costs anything.
// Capacity comes and goes on a fixed rhythm, so the whole flow (seen, gone, launched) can be watched in a browser.
// It exists only where DEV_TOOLS=1.
import {ProviderError} from '../types';
import type {Provider, Catalog, Offer} from '../types';

const CONFIGS = [
  {id: 'fake_8x_h100', name: '8x H100 SXM (test)', gpu: 'H100 SXM', gpus: 8, vcpus: 208, ramGb: 1933, diskGb: 23622, vramGb: 80, price: 31.92, currency: 'USD'},
  {id: 'fake_4x_h100', name: '4x H100 SXM (test)', gpu: 'H100 SXM', gpus: 4, vcpus: 104, ramGb: 966, diskGb: 11811, vramGb: 80, price: 16.36, currency: 'USD'},
  {id: 'fake_1x_a100', name: '1x A100 (test)', gpu: 'A100', gpus: 1, vcpus: 30, ramGb: 216, diskGb: 550, vramGb: 40, price: 1.99, currency: 'USD'}
];
const REGIONS = [{id: 'test-east-1', name: 'Test East'}, {id: 'test-west-1', name: 'Test West'}];
/* every minute: free for the first 20 seconds in the east, between 30 and 40 in the west; the 1x A100 is always free */
function offersAt(now: number): Offer[] {
  const s = Math.floor(now / 1000) % 60, out: Offer[] = [{config: 'fake_1x_a100', region: 'test-east-1', level: 'high'}];
  if (s < 20) out.push({config: 'fake_8x_h100', region: 'test-east-1', level: 'low'}, {config: 'fake_4x_h100', region: 'test-east-1', level: 'medium'});
  if (s >= 30 && s < 40) out.push({config: 'fake_8x_h100', region: 'test-west-1', level: 'medium'});
  return out;
}
export const fake: Provider = {
  id: 'fake',
  async validate(c) { if (!c.secret.startsWith('test')) throw new ProviderError('auth', 'Test keys start with "test".'); return {meta: {}, account: 'Test account'}; },
  async catalog(c): Promise<Catalog> {
    return {configs: CONFIGS, regions: REGIONS, offers: offersAt(c.now), at: c.now, account: 'Test account', notes: ['This is the test provider: nothing here is real and nothing costs money.'],
      options: {sshKeys: [{id: 'laptop', name: 'laptop'}], images: [{id: 'ubuntu-24-04', name: 'Ubuntu 24.04'}], storage: [{id: 'data', name: 'data (1 TB)', region: 'test-east-1'}]}};
  },
  async offers(c) { return offersAt(c.now); },
  async launch(c, p) {
    if (p.spec.launch && p.spec.launch.fail === 'quota') throw new ProviderError('quota', 'Test: the account may not start this.');
    if (Math.floor(c.now / 1000) % 60 >= 40 && p.config === 'fake_8x_h100') throw new ProviderError('capacity', 'Test: taken a moment ago.');
    return {extId: 'test-' + Math.random().toString(36).slice(2, 10), name: p.name, detail: {region: p.region, ip: '192.0.2.10'}};
  },
  async instance() { return {status: 'active', ip: '192.0.2.10'}; }
};
