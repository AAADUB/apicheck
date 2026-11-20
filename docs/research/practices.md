# GPU availability watchers, snipers and auto-launchers: prior art and practices

Research date: 20 Nov 2026. Sources: WebSearch/WebFetch, plus Cloudflare docs search. Every factual line has a URL. Lines marked **[REC]** are my engineering recommendations drawn from the sourced facts. They are not claims taken from any source.

Pages I could not read (permission prompts timed out or the site refused): gpus.skypilot.co (GPU Compass UI), skypilot.ai/blog/gpu-compass, docs.skypilot.ai (current failover docs; I used the v0.7/v0.9 docs instead), gpusignals.com (I used its Product Hunt page instead), status.lambda.ai, a Medium post on Lambda, and developers.cloudflare.com alarms page (I got the same content through the Cloudflare docs-search tool).

---

## 1. The most relevant tools and services

### 1a. Watchers, launchers and native "notify me" features

| # | Tool / service | What it does | Providers | Alert channels | Auto-launch | Pricing | URL |
|---|---|---|---|---|---|---|---|
| 1 | **SkyPilot** (OSS) | Launcher with automatic failover. On a capacity error it tries every region of the chosen cloud, then the next-cheapest cloud. Takes candidate resources as `ordered` (in preference order) or `any_of`. `sky launch -r/--retry-until-up` "retr[ies] provisioning infinitely until the cluster is up". GPU Compass is its multi-cloud price/launch dashboard. | Kubernetes, Slurm, AWS, GCP, Azure, OCI, CoreWeave, Nebius, Lambda, RunPod, Shadeform and more | None built in | Yes | Free (OSS) | https://docs.skypilot.co/en/v0.7.0/examples/auto-failover.html · https://docs.skypilot.co/en/v0.9.2/reference/cli.html · https://raw.githubusercontent.com/skypilot-org/skypilot/master/README.md |
| 2 | **dstack + gpuhunt** (OSS) | Launcher. A `retry` block with `on_events: [no-capacity]` and `duration` (e.g. `1h`) keeps retrying; the default is to fail when no capacity is found. Also has `max_price`, `spot_policy`, `regions`, `backends`, GPU name/count/memory ranges, CPU/RAM/disk minimums and `placement: cluster`. Auto-termination via `idle_duration`, `utilization_policy` and `max_duration`. `dstack offer` lists offers, and its JSON includes an `availability` field. gpuhunt is the offer catalog behind it. | gpuhunt: AWS, Azure, CloudRift, Crusoe, DigitalOcean, GCP, Hot Aisle, JarvisLabs, Lambda, Nebius, OCI, RunPod, Seeweb, Vast, Verda, Vultr | None built in | Yes | Free (OSS, MPL-2.0) | https://dstack.ai/docs/guides/protips/ · https://dstack.ai/docs/reference/dstack.yml/fleet/ · https://dstack.ai/docs/reference/cli/dstack/offer/ · https://github.com/dstackai/gpuhunt |
| 3 | **Shadeform** (marketplace API) | One API across many clouds. `GET /v1/instances/types?available=true&gpu_type=…&num_gpus=…` returns an `availability[]` array with one `{region, available, rental_type}` entry per region and rental type. Instance create accepts `auto_delete` and `alert` blocks, each with a `date_threshold` or `spend_threshold`. I found no native "notify when available". | Many neoclouds, plus your own AWS/Azure | Email, but only for spend/date alerts on running instances | Via API (you build the loop) | Marketplace prices | https://docs.shadeform.ai/api-reference/instances/instances-types.md · https://docs.shadeform.ai/api-reference/instances/instances-create |
| 4 | **RunPod "Deploy When Available"** (native queue) | When a spec is sold out, the deploy button becomes a queue. "Runpod watches for capacity and deploys your pod automatically." Queued-pod fields: `startsAt`, `expiresAt`, `allowedHours` (UTC hours per weekday), `notifyEmail`, and `dataCenterIds` (empty = any). Statuses: QUEUED, DEPLOYED, FAILED, EXPIRED, CANCELLED. FAILED comes with a reason: INSUFFICIENT_BALANCE, SPENDING_LIMIT, GPU_QUOTA_EXCEEDED, GPU_CONCURRENCY_EXCEEDED or ORG_RESTRICTED. Takes a single GPU type, not a priority list. | RunPod | Console and email (SMS planned) | Yes | Normal pod billing from the moment it deploys | https://runpod.io/blog/deploy-when-available-is-now-ga · https://docs.runpod.io/api-reference-v2/pods/list-queued-pods.md |
| 5 | **Nebius capacity advisor** | Per platform, preset, region, InfiniBand fabric and VM type it reports `availability_level` (HIGH / MEDIUM / LOW / LIMIT_REACHED), `available` (max VMs you could launch), `limit` (your quota), `effective_at` and `data_state` (fresh / stale / unknown). Available in the console (Administration → Capacity dashboard), the CLI (`nebius capacity resource-advice list`) and the SDKs. It does not guarantee capacity at creation time. | Nebius | None | No | Free | https://docs.nebius.com/compute/virtual-machines/capacity-advisor.md · https://nebius.com/blog/posts/introducing-capacity-blocks-and-dashboard |
| 6 | **Lyceum availability reminders** | "Notify when available" in the UI or API, keyed on hardware profile plus an exact GPU count (8 means 8 free, not ≥1). Fires once and is then marked done. Setting a second reminder for the same profile updates the existing one rather than duplicating it. Webhook delivery is best-effort with no retry. | Lyceum | Email (always) and an optional webhook (Slack-formatted when the host is hooks.slack.com, otherwise a JSON `hardware.available` event) | No | n/a | https://docs.lyceum.technology/docs/instances/availability-reminders |
| 7 | **Spheron "Notify me"** | Alert per GPU count and region. Notifications for the same returning GPU are batched, at most one per region every 30 min. Location-filtered views show a cross-region hint such as "In stock in USA and Norway". An alert does not reserve stock. | Spheron | Email only | No | n/a | https://www.spheron.network/blog/gpu-sold-out-get-notified-when-h100-or-b200-capacity-frees-u/ |
| 8 | **GPUSignals** (SaaS, early) | "Tracks and predicts" GPU availability: real-time alerts, heatmaps, usage trends. Auto-claim is promised "soon". | RunPod, Vast.ai, Lambda | Not stated | Not yet | "Free options" | https://www.producthunt.com/products/gpusignals |
| 9 | **PodScout** (Chrome extension) | Watches whether RunPod *saved pods* become available. Manual start/stop; auto-claim is a Pro feature. | RunPod | Alerts; SMS on Pro | Pro tier | Free + Pro (prices not stated) | https://www.producthunt.com/p/podscout/podscout |
| 10 | **strand-ai `lambda` CLI + MCP** | `lambda find -g <gpu> -s <sshkey> [--interval N]` polls (default every 10 s) and launches when the type appears. Also ships an MCP server with a `check_availability` tool. | Lambda | None | Yes | Free (OSS) | https://lobehub.com/mcp/strand-ai-lambda-cli |
| 11 | **cybrly `lambda_cli`** | `find --gpu <type> --sec 30 [--ssh key]` monitors and launches. | Lambda | None | Yes | Free (OSS) | https://github.com/cybrly/lambda_cli |
| 12 | **Giles Thomas `lambda-manager`** | `launch-when-available` polls the API, starts the requested type and sends a Telegram message. Built in about an hour with agentic coding. Was still waiting with "no luck" after 6 h for 8×A100 (Apr 2026). | Lambda | Telegram | Yes | Free (OSS) | https://www.gilesthomas.com/2026/04/automating-starting-lambda-instances |
| 13 | **jschoormans Lambda gist** | One-shot script, meant to run from cron. Posts available types and prices to Slack and launches A10/A100. Has a guard: it exits if any instance is already running. Has bugs (`exit()` inside a function, no error handling). | Lambda | Slack | Yes | Free | https://gist.github.com/jschoormans/fe732caf5af2e398beee47b9f261afd2 |
| 14 | **nerodesu017 `lambdalabs-sniper`** (Go) | Notifier only. Authenticates with the web `sessionid` cookie; the README warns this may hurt your Stripe score. Single commit, Aug 2023. | Lambda | Discord webhook | No | Free | https://awesome.ecosyste.ms/projects/github.com%2Fnerodesu017%2Flambdalabs-sniper |
| 15 | **Verda Cloud MCP `monitor_spot_availability`** | Polls the SDK's `is_available()`. Parameters: `check_interval` (30 s), `max_checks` (60 ≈ 30 min), `auto_deploy` (default false), and `volume_id` / `script_id` for the launch. | Verda (ex-DataCrunch) | Tool output | Optional | Free (OSS) | https://glama.ai/mcp/servers/sniper35/verda-cloud-mcp/tools/monitor_spot_availability |

Also relevant:
- **Prime Intellect** has a multi-provider availability endpoint (`/api/v1/availability/gpus`, filters `gpu_type`, `gpu_count`, `regions`, `socket`) that returns `stockStatus`, e.g. "Low". https://docs.primeintellect.ai/api-reference/check-gpu-availability
- **Vast.ai** notifications cover account, billing and instance events only, with no offer or saved-search alerts. Channels are email and webhooks. https://docs.vast.ai/guides/reference/notifications.md

### 1b. Price and stock trackers (useful as data sources or UI references, not launchers)

| Tracker | Availability? | Freshness | Alerts | URL |
|---|---|---|---|---|
| **gpuperhour.com** | Yes. A price shows only if the provider had that GPU in stock on demand within the last 15 min | Stock rechecked "about every minute"; footer shows the latest observation time | None mentioned | https://gpuperhour.com/blog/lambda-labs-alternatives |
| **getdeploying.com** | Partly, where providers expose availability APIs | Most GPU listings every 15 min or hourly; 130 providers (94 with GPU rentals) | None | https://getdeploying.com/our-data |
| **computeprices.com** | No real availability tracking | "Last updated" timestamps; 134 providers | Weekly email digest | https://computeprices.com/compare/cudo-compute-vs-upcloud |
| **CCIR GPU Availability index** | Yes. Share of probes that found launchable stock per venue; a venue counts only if its window rate is ≥10% | Daily, 7-day rolling; separate "Fractional" and "Cluster (8-GPU node)" views | No | https://ccir-site.pages.dev/availability |
| **GPU Tracker (iOS)** | Prices only | Hourly; price alerts checked every 15 min, delivered as push | Push (price threshold) | https://apps.apple.com/us/app/id6773427526 |
| **Apify "GPU Cloud Price & Availability Tracker"** | `onlyAvailable` filter for Vast, RunPod, Lambda | Per scheduled run | None | https://apify.com/genetheaiguy/gpu-cloud-price-tracker |

---

## 2. Feature inventory for setting up a watch job

Taken from the tools above. Bold = I saw it in at least one real product.

**Config selection**
- **GPU model + exact count.** Lyceum matches the count exactly (https://docs.lyceum.technology/docs/instances/availability-reminders). Spheron alerts are per count + region (https://www.spheron.network/blog/gpu-sold-out-get-notified-when-h100-or-b200-capacity-frees-u/).
- **Ranges for GPU count and memory, CPU, RAM, disk** (dstack: `gpu.count 1..`, `memory 8GB..`, `cpu.count 2..`; https://dstack.ai/docs/reference/dstack.yml/fleet/).
- **Interconnect / placement.** dstack has `placement: cluster`. Nebius reports per InfiniBand fabric. Prime Intellect filters by `socket` (PCIe/SXM). https://docs.nebius.com/compute/virtual-machines/capacity-advisor.md · https://docs.primeintellect.ai/api-reference/check-gpu-availability

**Regions**
- **Explicit region list** (dstack `regions`, RunPod `dataCenterIds`).
- **"Any region"**: RunPod's empty `dataCenterIds` (https://docs.runpod.io/api-reference-v2/pods/list-queued-pods.md).
- **Priority order**: SkyPilot tries every region in the cloud, then the next-cheapest cloud (https://docs.skypilot.co/en/v0.7.0/examples/auto-failover.html).
- **Cross-region hint** when your region is sold out (Spheron).

**Fallback configs**
- **Ordered candidate list**: SkyPilot `ordered` (e.g. A10 → A10g → L4) vs `any_of`. RunPod's queue does *not* support this (single `gpu` field).

**Price and rental type**
- **Max price per hour** (dstack `max_price`, `dstack offer --max-price`).
- **Spot vs on-demand vs auto** (dstack `spot_policy`). Shadeform returns availability separately per `rental_type` and advises filtering to `on_demand` before asking "is any region available?" (https://docs.shadeform.ai/api-reference/instances/instances-types.md).

**Polling interval**
- **User-settable**: strand-ai CLI default 10 s, cybrly `--sec 30`, Verda 30 s, Oracle sniper 60 s (sources in §1 and §3).

**Notify-only vs auto-launch**
- **Toggle** (Verda `auto_deploy` default false). Notify-only products: Lyceum, Spheron, Nebius, GPUSignals. Auto-launch: RunPod queue, SkyPilot, dstack and the Lambda CLIs.

**Limits**
- **Only launch if nothing is already running** (jschoormans gist).
- **Max checks / max wait duration** (Verda `max_checks`; dstack `retry.duration`; RunPod `expiresAt`).
- **Fixed node count** (dstack `nodes`).

**Stop after success**
- **One-shot**: Lyceum reminder fires once; RunPod queue → DEPLOYED; Oracle sniper's `while not instance_exist_flag` loop.

**Quiet hours**
- **RunPod `allowedHours`**, per weekday in UTC, so a pod does not deploy (and bill) while you are away (https://runpod.io/blog/deploy-when-available-is-now-ga).

**Re-notify rules**
- **Once per reminder**, then re-arm manually (Lyceum).
- **Rate-cap**: one alert per region per 30 min (Spheron).
- **Hysteresis by probe hit-rate**: count a venue as available only if ≥10% of probes in the window found stock (CCIR).
- **Dedupe**: a new reminder updates the pending one (Lyceum).

**Test notification**
- Not seen documented anywhere. **[REC]** Add one. Lyceum does not retry webhooks, so a broken endpoint fails silently except for the email.

**Dry run / single check**
- **Single check and list commands**: Verda `check_spot_availability`; lambda-manager `list-instance-types`; `dstack offer`.

**History / timeline**
- **Price history snapshots** (Apify, GPU Tracker 24h/7d/30d).
- **Availability index over time** (CCIR 7-day chart).
- **Heatmaps** (GPUSignals; details not public).

**Success / failure logs**
- **RunPod statuses + `failureReason`.** Nebius `data_state` / `effective_at`.

**Launch templates**
- **Image/OS, SSH key, volumes/filesystems, startup script or Docker, env vars, tags.** Shadeform: `os`, `ssh_key_id`, `volume_ids`, `launch_configuration`, `envs`, `tags`. Lambda: `image`, `ssh_key_names` (exactly one), `file_system_names`, `user_data` (cloud-init ≤1 MB), `firewall_rulesets`, `tags`. https://docs.lambda.com/api/cloud

**Safety on running instances**
- **Auto-delete at a date or spend threshold, plus an email alert** (Shadeform).
- **Auto-terminate when idle or underused** (dstack `idle_duration`, `utilization_policy`).
- **Lease with auto-terminate** (soong: 1–8 h leases; https://axiomantic.github.io/soong/stable/guides/launching-instances/).
- **Cost estimate + confirmation** before launch (soong, gpunow; https://github.com/0xfe/gpunow).
- **Default TTL of 12 h** (gpunow).

---

## 3. Best practices and pitfalls

### Rate limits and polling frequency
- **Lambda (current docs):** general API "limited to one request per second". Launch is "one request per 12 seconds, or five requests per minute". A 429 carries code `global/rate-limited` (https://docs.lambda.com/api/cloud). Older docs said 1 launch per 10 s (https://old.docs.lambdalabs.com/cloud/rate-limiting/).
  - **[REC]** Budget about ≤0.5 rps for polling `GET /api/v1/instance-types` (one call covers every type and region through `regions_with_capacity_available`). That leaves headroom for launch, status and list calls on the same key.
  - **[REC]** Never send more than one launch per 12 s per key.
- **RunPod v2:** quotas per minute, hour and day, exposed in the `RateLimit-Policy` and `RateLimit` headers. A 429 carries `Retry-After`. The official guidance: honour `Retry-After`, slow down when remaining (`r`) nears 0, cap retries, add random jitter, back off exponentially on GET 5xx and timeouts, and **before retrying a POST that creates a Pod, list your pods to check the first attempt did not succeed**. https://docs.runpod.io/api-reference-v2/rate-limits.md
- **Observed intervals in the wild:** 10 s (strand-ai CLI default), 30 s (cybrly example, Verda default), 60 s (Oracle sniper, which notes "< 60s risks 429" on OCI) (https://microck.github.io/oracle-sniper-writeup/). Lambda staff in 2022 suggested trying to launch about hourly. That advice was for manual use (https://deeptalk.lambda.ai/t/how-long-does-it-usually-take-for-gpus-to-become-available/3365).
- **Cloudflare specifics** (relevant to a Workers-based watcher):
  - Cron schedules have minute precision.
  - Durable Object alarms take a millisecond timestamp, but each object holds one alarm, alarms do not repeat (re-arm in the handler), and they retry on throw with exponential backoff from 2 s, up to 6 times.
  - Cloudflare's advice: catch exceptions and always re-arm, otherwise an outage can exhaust the retries and stop the loop.
  - Sources: https://developers.cloudflare.com/agents/runtime/capabilities/scheduler/ · https://developers.cloudflare.com/durable-objects/api/alarms/ · https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
  - **[REC]** Use a DO-alarm loop for sub-minute polling and keep a cron trigger as a watchdog that re-arms the alarm if it died.

### Jitter, backoff, error classification
- Classify errors into **soft** (rate-limited, out of capacity, 5xx/bad gateway) → sleep and retry, and **fatal** (everything else) → stop and alert, so config mistakes surface instead of retrying forever (Oracle sniper writeup).
- Lambda's distinct 400 codes:
  - `instance-operations/launch/insufficient-capacity` → soft.
  - `file-system-in-wrong-region`, `file-system-not-in-vpc`, `global/quota-exceeded`, `global/object-does-not-exist` → fatal; they need a config fix.
  - Source: https://docs.lambda.com/api/cloud
- Add jitter so clients do not retry in lockstep (RunPod docs). **[REC]** ±20–30% on the poll interval; exponential backoff after repeated 429s, capped and reset on success.

### The race: availability seen, launch fails
- An alert does not reserve stock; someone else may start the instance first (Spheron).
- Nebius data is accurate only "as of" its timestamp and does not guarantee availability at creation (Nebius docs).
- RunPod's queue can hit capacity and still FAIL on balance, spending limit, quota or concurrency (queued-pods docs).
- **[REC]** Treat "seen available" and "launch accepted" as separate events in logs and alerts. Retry the launch immediately in the *next* available region from the same snapshot, within the 5-launch/min limit, before going back to polling.

### Launching fast
- **Pre-validate everything that causes a fatal 400.** Lambda requires exactly one SSH key name, and filesystems must be in the instance's region, so a filesystem pins the region (https://docs.lambda.com/api/cloud). **[REC]** At job save time, check the key exists, check the filesystem region, and drop regions that are incompatible with the attached filesystem.
- **Fire the launch from the same handler that saw availability.** Don't queue it behind a notification. Notify after the launch response.
- **[REC]** Cache static data (instance-type names, SSH key ids). RunPod docs also recommend caching rarely-changing data to cut request volume.

### Double launches and runaway cost
- **Idempotency.** Before re-POSTing a create, list resources to check the first attempt did not land (RunPod docs). The gist exits if any instance is already running.
- **Instance and time limits.** Max checks or duration (Verda, dstack `retry.duration`, RunPod `expiresAt`).
- **Spend caps.** Shadeform `auto_delete.spend_threshold` + `alert`. dstack `max_duration`, `idle_duration`, `utilization_policy`. soong leases auto-terminate. gpunow terminates after 12 h by default.
- **Billing starts at deployment**, so a pod that deploys while you sleep costs money. Use quiet hours (RunPod).
- **[REC]** A single-writer lock per job (one Durable Object per job is a natural lock). Persist state as `launching` with a request id *before* the POST. On any ambiguous result (timeout, 5xx), reconcile by listing instances (filter by a unique name or tag) before retrying. Keep a hard global cap (max N running instances and a daily $ budget) checked before every launch.

### Verifying the instance after launch
- Boots can be slow. soong recommends terminating and relaunching if an instance stays "booting" for more than 5 min (https://axiomantic.github.io/soong/stable/guides/launching-instances/). gpunow waits for a readiness endpoint before marking a VM ready (https://github.com/0xfe/gpunow). Lambda has had status-page incidents for slow launches and boots (https://isdown.app/status/lambda-gpu-cloud/incidents/609929-us-south-2-slow-booting-of-newly-launched-instance).
- **[REC]** After launch, poll the instance until `active` with an IP, then optionally run an SSH or `user_data` health check (e.g. `nvidia-smi` reports 8 GPUs) that posts back to a webhook. Alert at three stages: "launched", "ready", "not ready after X min".

### Auto-terminate safety
- Spend/date auto-delete (Shadeform), idle and utilization policies (dstack), leases (soong), default TTL (gpunow).
- **[REC]** For a competition where losing the box is worse than paying for it, use alert-only by default. Add an optional hard TTL with a warning notification before it fires.

### How fast capacity disappears; when it appears
- **No reliable public measurement of how long GPU windows last on Lambda or the other neoclouds.**
  - The closest claim is non-GPU: the OCI sniper write-up speaks of "the 3-second window when a slot opens" (https://microck.github.io/oracle-sniper-writeup/).
  - gpuperhour itself says "no Lambda document quantifies" out-of-capacity (https://gpuperhour.com/blog/lambda-labs-alternatives).
- **Anecdotes of very long waits:**
  - 6 h with no 8×A100 on Lambda (Apr 2026).
  - About 2 weeks with no instance at all (Oct 2023).
  - 3 days without a cheap RTX6000 (Sep 2024).
  - Sources: https://www.gilesthomas.com/2026/04/automating-starting-lambda-instances · https://deeptalk.lambda.ai/t/lambda-labs-is-out-of-capacity-for-all-instances-how-long-will-this-persist/3899 · https://deeptalk.lambda.ai/t/rtx6000-instances-no-longer-listed/4350
- **Market context:**
  - SemiAnalysis (2 Apr 2026): "On-Demand GPU rental capacity is sold out across all GPU types", and holders won't release instances (https://newsletter.semianalysis.com/p/the-great-gpu-shortage-rental-capacity).
  - Lambda staff: instances "become available every so often", and capacity depends on when other customers release theirs (deeptalk threads above).
- **Time of day:** no source gives a time-of-day pattern for cloud GPU capacity.
  - One AWS/GCP harness was built to measure it (≈48 trials/day at randomized times) but publishes no results (https://github.com/piercefreeman/cloud-gpu-reliability).
  - **[REC]** That gap is the reason to log every poll and build your own hour-of-week heatmap.

### Provider-specific notes for the planned set (Lambda, UpCloud, Nebius, RunPod)
- **UpCloud:** GPU servers are in `fi-hel2` (Helsinki). Each account gets access to a limited number of GPUs based on account history, and promotional credits can't be used for GPUs. I found no documented availability endpoint. https://upcloud.com/docs/products/gpu-servers/availability/
- **Nebius:** use the capacity advisor API (`availability_level`, `available`, `data_state`) as the signal. Note that MEDIUM means launches "may fail".
- **RunPod:** consider its native queue (with `allowedHours` and `expiresAt`) instead of, or alongside, your own poller.
- **Lambda:** poll `instance-types` and read `regions_with_capacity_available`.

---

## 4. UI/UX patterns for a small private dashboard

**Status and freshness**
- **Status badge per job:** `Watching` / `Seen` / `Launching` / `Launched` / `Ready` / `Failed (reason)` / `Expired` / `Paused`. Modeled on RunPod's QUEUED/DEPLOYED/FAILED+failureReason/EXPIRED/CANCELLED (https://docs.runpod.io/api-reference-v2/pods/list-queued-pods.md).
- **Graded availability, not a boolean,** where the provider allows it: Nebius HIGH/MEDIUM/LOW/LIMIT_REACHED plus an `available` count (https://docs.nebius.com/compute/virtual-machines/capacity-advisor.md).
- **Freshness is explicit:**
  - Nebius `data_state` fresh/stale/unknown + `effective_at`.
  - gpuperhour shows a price only if seen in stock within 15 min, with a "latest observation" footer (https://gpuperhour.com/blog/lambda-labs-alternatives).
  - **[REC]** Show "last poll 4 s ago" per provider, and grey out a provider row when it is stale or its last poll errored. Never show stale data as green.

**History**
- **Probe hit-rate rather than single events:** CCIR plots the share of probes that found stock over a 7-day window and counts a venue only at ≥10% (https://ccir-site.pages.dev/availability). **[REC]** A per-provider and per-region sparkline of hit-rate, plus a list of "availability windows" (start, end, duration, regions).
- **Heatmaps:** GPUSignals advertises them (https://www.producthunt.com/products/gpusignals). **[REC]** A 7×24 hour-of-week grid (UTC and Dubai time) coloured by the share of polls with capacity for the selected config. The same grid can serve as the quiet-hours editor, mirroring RunPod's per-weekday `allowedHours` (https://runpod.io/blog/deploy-when-available-is-now-ga).
- **Separate views for fractional vs full-node capacity** (CCIR "Fractional" vs "Cluster 8-GPU"). For an 8×H100 hunt, only full-node matters.

**Discovery and setup**
- **Cross-region hint** when the chosen region is empty ("In stock in USA and Norway", Spheron).
- **Filters:** GPU, count, rental type, provider, region, max $/h. `dstack offer --group-by gpu,backend,region` shows price ranges per group (https://dstack.ai/docs/reference/cli/dstack/offer/).
- **Job form = launch template + guards.** Template: image, SSH key, filesystem, startup script, env. Guards: max instances, spend cap, expiry, quiet hours, notify-only vs auto-launch. Show a cost estimate and an explicit confirmation as in soong and gpunow.

**Event log and notifications**
- **Live timeline:** one row per event (poll error, availability seen, launch attempt with HTTP code / error code, launched, ready), filterable by job and provider.
- **Notification rules UI:**
  - "notify once per window" + "re-notify after N min" (Spheron's 30-min cap, Lyceum's one-shot).
  - A **Send test** button.
  - Per-channel delivery status, since webhooks may not be retried (Lyceum).
