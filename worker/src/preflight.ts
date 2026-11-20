// The account guard and the launch preflight, shared by the engine and the API.
import type {Provider, Ctx, Machine, Check} from './types';
import {ProviderError} from './types';

type W = {spec: Record<string, any>; max_launch: number};

/** the name every launch gives its machine: the chosen base, a dash and six hex digits of the launch id */
export const baseOf = (spec: Record<string, any>) => String((spec.launch && spec.launch.name) || 'apicheck').slice(0, 40);
export const ours = (spec: Record<string, any>, name: string) => { const b = baseOf(spec); return name.startsWith(b + '-') && /^[0-9a-f]{6}$/.test(name.slice(b.length + 1)); };

/** machines that stop a launch: any machine API Check started for this name, and, unless the guard is off, any machine of a configuration the watch hunts for */
export function blockers(ms: Machine[], w: W): Machine[] {
  const configs = new Set<string>(w.spec.configs || []);
  const count = w.spec.params && Number(w.spec.params.count);
  const same = (m: Machine) => configs.has(m.config) && (m.gpus == null || !count || m.gpus === count);
  return ms.filter(m => ours(w.spec, m.name) || (w.spec.guard !== false && same(m)));
}

/** reads only. Each line says what a launch would use and whether the provider would take it. */
export async function preflight(P: Provider, c: Ctx, w: W): Promise<Check[]> {
  const out: Check[] = [];
  if (P.preflight) {
    try { out.push(...await P.preflight(c, w.spec)); }
    catch (e) { out.push({level: e instanceof ProviderError && e.kind === 'auth' ? 'fail' : 'warn', text: 'Could not finish the check: ' + (e as Error).message}); }
  } else out.push({level: 'warn', text: 'This provider has no launch check; only a real launch will tell.'});
  if (P.active) {
    try {
      const ms = await P.active(c, w.spec), b = blockers(ms, w);
      if (b.length >= w.max_launch) out.push({level: 'fail', text: `The account already runs ${b.map(m => `${m.name || m.extId} (${m.config}, ${m.region || 'region unknown'}, ${m.status})`).join(', ')}. The account guard will not start another until ${b.length === 1 ? 'it is' : 'they are'} terminated${w.spec.guard !== false ? ' or the guard is turned off' : ''}.`});
      else if (b.length) out.push({level: 'warn', text: `The account already runs ${b.length} machine${b.length === 1 ? '' : 's'} of this kind; the watch may start ${w.max_launch - b.length} more.`});
      else out.push({level: 'ok', text: ms.length ? `The account runs ${ms.length} other machine${ms.length === 1 ? '' : 's'}, none of this kind.` : 'The account runs no machines now.'});
    } catch (e) { out.push({level: 'warn', text: 'Could not list the machines in the account: ' + (e as Error).message}); }
  }
  return out;
}
