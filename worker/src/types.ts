export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  WATCHER: DurableObjectNamespace;
  LOGIN_LIMIT?: {limit(o: {key: string}): Promise<{success: boolean}>};
  KEK_CURRENT?: string;      // version number of the master key in use
  KEK_1?: string;            // 32 random bytes, base64 (secret)
  KEK_2?: string;
  SETUP_TOKEN?: string;      // creates the first administrator, and recovers an administrator's password (secret)
  DEV_TOOLS?: string;        // "1" skips live key checks and enables the fake provider; never set in production
  EMAIL?: {send(m: {to: string; from: {email: string; name: string}; subject: string; text: string; html?: string}): Promise<{messageId: string}>};
  MAIL_FROM?: string;        // sender address on a domain onboarded to Cloudflare Email Service
  APP_URL?: string;          // public address, used for links in emails
}

/** How sure a provider is that a configuration can be started in a region right now. */
export type Level = 'high' | 'medium' | 'low' | 'yes' | 'none';

/** One configuration a provider sells: a machine type, a plan, a platform preset or a GPU type and count. */
export interface Config {
  id: string;                 // the provider's own identifier, used in the launch request
  name: string;               // what people call it
  gpu: string;                // e.g. "H100 SXM"
  gpus: number;
  vcpus?: number;
  ramGb?: number;
  diskGb?: number;
  vramGb?: number;            // per GPU
  price?: number;             // per hour for the whole machine
  spot?: number;              // per hour, interruptible, where the provider sells it
  currency?: string;          // USD unless said
  regions?: string[];         // where it is sold at all; absent = everywhere the provider has
  note?: string;
}
export interface Region { id: string; name: string; }
/** One observation: this configuration in this region, at this level. */
export interface Offer { config: string; region: string; level: Level; note?: string; }
export interface Option { id: string; name: string; region?: string; detail?: string; }
export interface Catalog {
  configs: Config[];
  regions: Region[];
  offers: Offer[] | null;      // null = the provider has no availability signal; only a launch attempt tells
  options: Record<string, Option[]>;   // lists the launch form chooses from: images, ssh keys, storage and so on
  account?: string;            // who the key belongs to, as the provider names it
  notes?: string[];
  at: number;
}
export interface Ctx {
  secret: string;              // the decrypted credential
  meta: Record<string, any>;
  fetch: typeof fetch;
  now: number;
}
export interface LaunchPlan { config: string; region: string; name: string; spec: Record<string, any>; }
export interface Launched { extId: string; name?: string; price?: number; currency?: string; detail?: Record<string, unknown>; }

/** Why a provider call failed. A sniper treats them differently:
 *  capacity: nothing free right now, try again next check;
 *  rate: slow down; auth: the key is refused, stop and tell;
 *  quota: the account may not start this, stop and tell; invalid: the request is wrong, stop and tell;
 *  money: not enough balance or credit; http: the provider is down or answered oddly, try again with a delay. */
export type FailKind = 'capacity' | 'rate' | 'auth' | 'quota' | 'invalid' | 'money' | 'http';
export class ProviderError extends Error {
  constructor(public kind: FailKind, message: string, public status = 0, public retryAfter = 0) { super(message); }
}

export interface Provider {
  id: string;
  /** a cheap authenticated call; returns facts to keep with the key */
  validate(c: Ctx): Promise<{meta: Record<string, any>; account?: string}>;
  /** everything the setup form needs, with availability where the provider reports it */
  catalog(c: Ctx): Promise<Catalog>;
  /** availability only, as fast as the provider allows; null = no signal (UpCloud) */
  offers(c: Ctx, watch: {spec: Record<string, any>}): Promise<Offer[] | null>;
  /** start a machine named plan.name. The name is unique to this attempt (it ends in part of the launch id), so find() can tell later whether it exists. */
  launch(c: Ctx, plan: LaunchPlan): Promise<Launched>;
  /** look for a machine by the exact name a launch gave it: how an unclear or interrupted launch is settled without starting a second machine */
  find?(c: Ctx, plan: LaunchPlan): Promise<{extId: string; status?: string} | null>;
  /** read a machine back after launch: status and address */
  instance?(c: Ctx, extId: string, region: string): Promise<Record<string, unknown> | null>;
}
