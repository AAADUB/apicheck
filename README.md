# API Check

A closed workspace that watches GPU clouds through their own APIs and, the moment a chosen configuration can be started, emails you or starts the machine.

Providers: **Lambda**, **UpCloud**, **Nebius**, **RunPod**, **Hyperstack** (plus a test provider that exists only with `DEV_TOOLS=1`).

## How it works

- **Keys.** A person adds a provider credential. It is checked with the provider once, sealed with AES-256-GCM under a per-record key derived (HKDF) from the `KEK_<n>` secret, bound to the key and user ids, and never shown again.
- **Watches.** A watch names one or more configurations in order of preference, the regions (or any), what to do when one is free (email, or start the machine with the launch settings), how often to check, an optional price cap, start and end time, and how many machines to start at most.
- **Engine.** One Durable Object (`Watcher`) per key runs every watch on that key from an alarm loop: one availability request per check serves all of them, launches on one key happen one at a time, and checks can run every few seconds. A one-minute cron re-arms any loop that should be running.
- **Launch safety.** The launch row is written before the provider is asked. A capacity refusal is retried on the next check; a rate limit or provider failure waits; a refusal that would repeat (key, quota, invalid request, balance) stops the watch and emails you; an unclear answer (timeout) stops the watch so a second machine is never started by mistake. API Check never stops or terminates machines.
- **Email** goes through Cloudflare Email Service from `apicheck@mail.miartech.co`: one message when capacity appears, again only after it is gone and a quiet time has passed; one when a machine starts; one when a watch stops or cannot check for 30 minutes.

## What each provider gives (read 20.11.2026)

| Provider | Availability signal | Launch | Notes |
|---|---|---|---|
| Lambda | `GET /api/v1/instance-types` → `regions_with_capacity_available` (exact) | `POST /instance-operations/launch`, one per 12 s | ~1 request/s; exactly one SSH key; filesystems are regional; new accounts have an instance limit |
| UpCloud | `GET /1.3/device/availability` → free units per GPU plan and zone (meaning of the number undocumented) | `POST /1.3/server`, 409 `SERVER_RESOURCES_UNAVAILABLE` = no capacity | GPU plans have no disk: storage is always sent; account GPU limit `resource_limits.gpus`; spot plans are `GPU-SPOT-…` |
| Nebius | capacity advisor `GET /capacity/v1/resource-advice?parentId=<tenant>` (high/medium/low, quota-aware) | `POST /compute/v1/instances` + operation polling; failed VMs are deleted with their boot disk | Service-account key → RS256 JWT → 12 h token from `auth.eu.nebius.com`; on-demand or preemptible |
| RunPod | REST v2 `GET /v2/catalog/gpus?include=AVAILABILITY&product=POD&count=N&cloud=C` per data center | `POST /v2/pods`; 400 = not placed, 402 balance, 422 bad request | REST v1 retired 15.11.2026; pods are containers (no Docker inside) |
| Hyperstack | `GET /core/flavors` (`stock_available` per flavor and region) and `GET /core/stocks` (machines deployable per GPU count) | `POST /core/virtual-machines` with the region's environment, SSH key and image | 500 requests/min per IP; no documented "no capacity" code |

The full notes behind this table are in `docs/research/`.

## Layout

```
shared/providers.js   what each provider needs: key fields, launch form, limits, choices (the browser and the Worker both use it)
worker/src/           index.ts (router, cron), auth.ts (closed workspace, same scheme as API Balance), app.ts (API), watcher.ts (engine),
                      providers/ (lambda, upcloud, nebius, runpod, fake, net), crypto.ts, notify.ts
web/src/              main.js (all screens), api.js, styles.css, template.html
migrations/           D1 schema
qa/check.py           Playwright walk-through with the test provider: every screen, five widths, dark theme, axe, overflow, duplicate ids
```

## Commands

```
npm install --legacy-peer-deps
npm run build        # dist/; stops on untranslated text, an error code without a message, or anything shaped like a real key
npm test             # Worker tests in workerd: adapters on recorded shapes, API, engine, isolation between people
npm run typecheck
```

Local run: copy `.dev.vars.example` to `.dev.vars`, `npx wrangler d1 migrations apply apicheck --local`, `npx wrangler dev --port 8790`, then `python3 qa/check.py`.

## Production

Worker `apicheck` at https://apicheck.aaadub.workers.dev, D1 `apicheck`, Durable Object `Watcher`, cron every minute, Workers Builds from this repository on every push to `main`.
Secrets: `KEK_1` (generated inside Cloudflare, never seen). `SETUP_TOKEN` is not set; to recover an administrator: set it, use the first-run form with that administrator's email, delete it.
Never set `DEV_TOOLS` in production.

## Launch safety

A machine costs money, so a watch can never start more than it is allowed to:

1. Before the provider is asked, a launch row is claimed in D1 with one conditional `INSERT … SELECT … WHERE`: it only succeeds if the watch is still on and the watch (and its shared group, if any) has fewer pending, created or unknown launches than its limit. The claim is atomic across Durable Objects, keys and providers.
2. Each attempt gets a unique machine name (it ends in part of the launch id).
3. An unclear answer (timeout, network failure, 5xx, a reply without an id) is settled by asking the provider for a machine with that name, three times over about 30 seconds. Found: it is recorded and counted. A timeout with nothing found: the launch stays `unknown`, counts against the limit, the watch stops and cannot be resumed until the launch is deleted on the Machines page. A 5xx with nothing found: a refusal; the hunt goes on.
4. A launch interrupted by a restart (deploy, eviction) is left `pending`; after 150 seconds the next check looks it up by name the same way.
5. Inside one key, the Durable Object runs one turn at a time, so two watches on one key never launch in the same instant.
