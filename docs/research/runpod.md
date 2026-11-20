# Runpod API for a GPU sniper (Cloudflare Worker, plain fetch)

Researched 20.11.2026 from the official docs (docs.runpod.io, `.md` versions of the pages), graphql-spec.runpod.io (via an index of it), runpod.io/pricing, and the runpod-python GitHub issues.
Spelling note: the company now writes its name "Runpod". "RunPod" is the pre-June-2025 styling.

> **TL;DR, critical facts**
> 1. **REST v1 (`https://rest.runpod.io/v1`) was RETIRED on 15 Nov 2026.** The release notes for 15.11.2026 say: "REST API v1 retired… Migrate your integrations to REST API v2 to restore access." Do **not** build on v1. Section 3b keeps the v1 schema for reference only.
> 2. **GraphQL (`https://api.runpod.io/graphql`) is deprecated and "will be retired in early 2027".** It still works for the December 2026 competition, but use it only as a fallback.
> 3. **Build on REST v2: `https://api.runpod.io/v2`.** (The brief's `docs.runpod.io/api-reference-v2/...` pages document this host. It is **not** rest.runpod.io.)
> 4. **v2 has a native "deploy when available" queue.** Add `"queue": {}` to `POST /v2/pods`. If there is no capacity, the API returns `202` and a `QueuedPod`, and Runpod's scheduler retries "about every five minutes". This is limited to Secure Cloud GPU pods and to plans that include the feature. A sniper should poll **and** queue: polling reacts faster, and the queue is the safety net.
> 5. **Spot/interruptible pods no longer exist.** v2 removed them, and the GraphQL spec marks `minimumBidPrice` with "Spot pods are no longer offered".
> 6. **A v2 pod takes exactly one GPU type and does not fall back to another.** The API reports "no capacity" as **HTTP 400** with only a human-readable `detail`. There is no machine-readable error code for it.

---

## 1. Auth, base URLs, rate limits

### Base URLs
| API | Base URL | Status |
|---|---|---|
| REST v2 | `https://api.runpod.io` (paths start with `/v2/...`) | GA since 18 Aug 2026. Use this. |
| REST v2 OpenAPI | `https://api.runpod.io/v2/openapi.json` | |
| REST v1 | `https://rest.runpod.io/v1` (OpenAPI `https://rest.runpod.io/v1/openapi.json`) | **Retired 15 Nov 2026** |
| GraphQL | `https://api.runpod.io/graphql?api_key=KEY` | Deprecated. "will be retired in early 2027" |

Sources: https://docs.runpod.io/api-reference-v2/overview.md, https://docs.runpod.io/api-reference-v2/migrate-from-v1.md, https://docs.runpod.io/release-notes.md, https://docs.runpod.io/sdks/graphql/configurations.md

### Auth (v2)
- Send `Authorization: Bearer <RUNPOD_API_KEY>`. The OpenAPI `securitySchemes.bearerAuth` has `bearerFormat: Runpod API Key`. "Keys are scoped to the permissions granted when created; requests may return `403` when a valid key lacks access."
- `X-Team-Id: <team_id>` applies only to console sessions. "API keys created inside a team already act for that team and do not need the header."
- The migration guide says v1 keys work on v2 unchanged: "You don't need to change key management or scopes to call v2."
- Key creation in the console (https://docs.runpod.io/get-started/credentials.md) offers three permission levels: **All**, **Restricted**, or **Read Only**. Legacy keys from before 11 Nov 2024 have GraphQL Read/Write or Read Only access.
- **Scopes stated on the v2 reference pages ("Required API key scope"):**

| Endpoint | Scope |
|---|---|
| `GET /v2/catalog/gpus`, `/gpus/{id}`, `/datacenters`, `/templates` | `catalog:read` |
| `GET /v2/queued-pods` | `pods:read` |
| `POST /v2/pods/{id}/action` | `pods:write` |
| `POST /v2/pods` | not printed on the page. It is almost certainly `pods:write`; verify in the console. |
| `POST /v2/network-volumes` | `volumes:write` |
| `GET /v2/account`, `GET /v2/account/limits` | `account:read` |
| `GET /v2/billing/balance` | `billing:read` |
| `PUT /v2/account/ssh-keys` | `authentication:write` |

### Errors (v2)
v2 errors use RFC 9457 `application/problem+json`:
```json
{ "title": "Bad Request", "status": 400, "detail": "request could not be processed", "errors": ["$: additional properties 'bogus' not allowed"] }
```
- v2 **rejects unknown body fields** with a `422` that names the field, for example `additional properties 'dataCenterId' not allowed`.
- **Unknown query params are silently ignored.** For example, `GET /v2/pods?desiredStatus=RUNNING` returns all pods.
- Body limit is 1 MiB in general (`413`). For `POST /v2/pods` it is **102400 bytes**, counting the expanded template settings.

### Rate limits (v2)
Source: https://docs.runpod.io/api-reference-v2/rate-limits.md and the `RateLimitHeader` / `RateLimitPolicyHeader` schemas in the OpenAPI.
- Quotas are per **user** across three fixed, clock-aligned windows: minute, hour and day. Every request counts against all three. "every `/v2` route counts toward the same limits; creating pods has no separate limit."
- Headers on every authenticated response (IETF draft):
  - `RateLimit-Policy: "minute";q=180;w=60, "hour";q=3600;w=3600, "day";q=43200;w=86400` (doc example. "Read the current quotas from this header instead of hard-coding them")
  - `RateLimit: "minute";r=0;t=12, "hour";r=2800;t=1812, "day";r=49500;t=45012` (`r` = remaining, `t` = seconds until reset)
  - If the headers are absent, the caller is exempt.
- A `429` carries `Retry-After` (integer seconds) and `detail` such as `"rate limit exceeded for the minute window"`. "A 429 only slows you down… Your account isn't suspended."
- Retry guidance: retry 5xx and timeouts on GET with backoff. **Before retrying a POST that creates a pod, list pods to check whether the first attempt succeeded.** Do not retry other 4xx errors unchanged.
- Sniper budget at the example quota: 3600/hour = 1 req/s sustained, and 43200/day = 0.5 req/s averaged over a day. **Polling one catalog call every 3–5 s (≈17k–29k/day) fits within the day quota.** A 1 s cadence (86 400/day) does not.

---

## 2. GPU catalog with availability (REST v2)

### `GET /v2/catalog/gpus`
Scope `catalog:read`. Source: https://docs.runpod.io/api-reference-v2/catalog/list-gpu-types.md

Query params (comma-separated, `style: form, explode: false`):
| Param | Type | Default | Notes |
|---|---|---|---|
| `include` | array, max 1 | none | Only `AVAILABILITY` |
| `product` | `POD`,`CLUSTER`,`SERVERLESS` | **none** | **Required with `include=AVAILABILITY` and valid only with it (400 either way).** |
| `count` | int ≥1 | `1` | "GPU count for availability and lowest-price calculations". Valid only with AVAILABILITY. |
| `cloud` | `SECURE`\|`COMMUNITY` | `SECURE` | Only with AVAILABILITY |
| `countryCodes` | `^[A-Z]{2}$`[] | none | OR semantics. Only with AVAILABILITY. On the list endpoint, GPU types with no data center in those countries drop out entirely. |
| `cudaVersions` | `^\d+\.\d+$`[] | none | Exact match. Mutually exclusive with `minCudaVersion`. |
| `minCudaVersion` | `^\d+(\.\d+)?$` | none | Numeric floor. A bare major such as `12` is OK here. |

Example: `GET https://api.runpod.io/v2/catalog/gpus?include=AVAILABILITY&product=POD&count=8&cloud=SECURE`

Response `200`: `{ "gpus": GpuType[] }`

`GpuType` schema:
| Field | Type | Notes |
|---|---|---|
| `id` | string, req | **Use this for pod creation**, e.g. `"NVIDIA H100 80GB HBM3"` |
| `name` | string, req | display name, e.g. `"H100 SXM"` |
| `pool` | string\|null, req | serverless pool id (e.g. `ADA_24`) |
| `manufacturer` | `NVIDIA`\|`AMD`\|`UNKNOWN` | |
| `memory` | int, req | VRAM GB |
| `secure` / `community` | bool, req | offered on that cloud |
| `price` | `{secure: number, community: number, serverless?: number}` req | USD/h for a **single** GPU. Multiply by count. The actual billed rate is `cost` on the pod. |
| `maxCount` | `{secure: int, community: int}` req | Largest machine (GPU count per pod) in that cloud. "a ceiling, not a stock level" |
| `minVcpuCount` | int, optional | Only with AVAILABILITY. "Minimum **total** vCPU count reported across matching machines for the requested `count`". Omitted when availability is NONE. |
| `minRam` | int, optional | Only with AVAILABILITY. Minimum **total** host RAM (GB) across matching machines for that `count`. Omitted when NONE. |
| `availability` | `NONE`\|`LOW`\|`MEDIUM`\|`HIGH` | Only with AVAILABILITY |
| `dataCenters` | `[{id, name, availability}]` | Only DCs that offer this GPU in the requested configuration. **Omitted entirely when unavailable everywhere.** |
| `cudaVersions` | `[{version:"12.8", available: bool}]` | `available=false` means the version is offered but currently full, so a pod pinned to it will fail on capacity. Absent for AMD. |

Doc example:
```json
{ "gpus": [ { "id": "NVIDIA GeForce RTX 4090", "name": "RTX 4090", "pool": "ADA_24", "manufacturer": "NVIDIA",
  "memory": 24, "secure": true, "community": true,
  "price": { "secure": 0.44, "community": 0.31, "serverless": 1.1 },
  "maxCount": { "secure": 8, "community": 4 },
  "availability": "HIGH",
  "dataCenters": [ { "id": "US-KS-2", "name": "US Kansas 2", "availability": "HIGH" } ] } ] }
```
**Note:** the API uses `memory`, `name` and `price.secure`. The GraphQL-style names `memoryInGb`, `displayName` and `securePrice` are **not** valid here.

### `GET /v2/catalog/gpus/{id}`
Scope `catalog:read`. Source: https://docs.runpod.io/api-reference-v2/catalog/get-a-gpu-type.md
- Same query params, and the response is a single `GpuType`.
- The id contains spaces, so URL-encode it with `encodeURIComponent`, e.g. `/v2/catalog/gpus/NVIDIA%20H100%2080GB%20HBM3?include=AVAILABILITY&product=POD&count=8`. The docs don't show the encoding explicitly.
- With `countryCodes`, the single endpoint still returns the type with `availability: NONE` and `dataCenters` omitted. A `404` means the GPU type doesn't exist.
- Doc advice: "Read the NONE on availability rather than the absence of dataCenters."

### `GET /v2/catalog/datacenters`
Scope `catalog:read`. Source: https://docs.runpod.io/api-reference-v2/catalog/list-data-centers.md
- Params:
  - `include=GPU_AVAILABILITY,CPU_AVAILABILITY`
  - `regions` (OR): `NORTH_AMERICA, SOUTH_AMERICA, EUROPE, ASIA, MIDDLE_EAST, AFRICA, OCEANIA, ANTARCTICA, UNKNOWN`
  - `networkVolumeTypes` (AND): `STANDARD, HIGH_PERFORMANCE`
  - `compliance` (AND): `GDPR, ISO_IEC_27001, ISO_14001, PCI_DSS, HITRUST, SOC_1_TYPE_2, SOC_2_TYPE_2, SOC_3_TYPE_2, ITAR, FISMA_HIGH, HIPAA, RENEWABLE`
  - `globalNetwork` (bool)
- Response `{ "dataCenters": [ { id, name, region, globalNetwork, networkVolumeTypes[], compliance[], gpuAvailability?: [{id, name, availability}], cpuAvailability?: [...] } ] }`
- **Caveat:** `gpuAvailability` here has **no `count` parameter**, so it is not reliable for 8× configurations. For an 8-GPU check, use `/v2/catalog/gpus?...&count=8` and read `dataCenters[]`.
- `GET /v2/catalog/datacenters/{id}` also exists.

Known data center IDs (enum from the v1 OpenAPI; the live list comes from `/v2/catalog/datacenters`):
`EU-RO-1, CA-MTL-1, EU-SE-1, US-IL-1, EUR-IS-1, EU-CZ-1, US-TX-3, EUR-IS-2, US-KS-2, US-GA-2, US-WA-1, US-TX-1, CA-MTL-3, EU-NL-1, US-TX-4, US-CA-2, US-NC-1, OC-AU-1, US-DE-1, EUR-IS-3, CA-MTL-2, AP-JP-1, EUR-NO-1, EU-FR-1, US-KS-3, US-GA-1`

### GPU type IDs
Source: https://docs.runpod.io/references/gpu-types.md
| GPU ID (use in API) | Display name | VRAM GB |
|---|---|---|
| `NVIDIA H100 80GB HBM3` | H100 SXM | 80 |
| `NVIDIA H100 PCIe` | H100 PCIe | 80 |
| `NVIDIA H100 NVL` | H100 NVL | 94 |
| `NVIDIA H200` | H200 SXM | 141 |
| `NVIDIA H200 NVL` | NVIDIA H200 NVL | 143 |
| `NVIDIA B200` | B200 | 180 |
| `NVIDIA B300 SXM6 AC` | B300 | 288 |
| `NVIDIA A100-SXM4-80GB` | A100 SXM | 80 |
| `NVIDIA A100 80GB PCIe` | A100 PCIe | 80 |
| `AMD Instinct MI300X OAM` | MI300X | 192 |
| `NVIDIA RTX PRO 6000 Blackwell Server Edition` | RTX PRO 6000 | 96 |
| `NVIDIA L40S` | L40S | 48 |

### GraphQL alternative (deprecated; retirement early 2027)
Endpoint `POST https://api.runpod.io/graphql?api_key=KEY`, `content-type: application/json`. Sources: https://docs.runpod.io/sdks/graphql/manage-pods.md, https://graphql-spec.runpod.io/ (seen via an index of the spec; fetching it directly timed out).
```graphql
query { gpuTypes(input: { id: "NVIDIA H100 80GB HBM3" }) {
  id displayName memoryInGb secureCloud communityCloud securePrice communityPrice maxGpuCountSecureCloud maxGpuCountCommunityCloud
  lowestPrice(input: { gpuCount: 8, secureCloud: true }) {
    stockStatus uninterruptablePrice availableGpuCounts maxUnreservedGpuCount minVcpu minMemory
    gpuTypeDatacenters { ... }   # type GpuTypeDataCenterAvailability (subfields not verified)
  } } }
```
- `stockStatus` values are `High`, `Medium`, `Low`, `None` (mixed case. v2 uses UPPERCASE).
- `LowestPrice` fields seen in the spec: `gpuName, gpuTypeId, minimumBidPrice` (marked **"Spot pods are no longer offered"**), `uninterruptablePrice, clusterPrice, isPrivatePool, minMemory, minVcpu, rentalPercentage, rentedCount, totalCount, stockStatus, minDownload, minDisk, minUpload, countryCode, supportPublicIp, compliance, maxGpuCount, maxUnreservedGpuCount, availableGpuCount, availableGpuCounts, gpuTypeDatacenters, gpuTypeCudaVersions`.
- The spec example for the lowestPrice input shows `countryCode, dataCenterIds, gpuCount, minDisk, minDownload, minMemoryInGb, minUpload, minVcpuCount, secureCloud, supportPublicIp, totalDisk, cudaVersion, allowedCudaVersions, minCudaVersion, compliance, isCluster, podCount, globalNetwork, machineProducts, supplyScope`. I inferred from that example that this is the `GpuLowestPriceInput` type. Treat it as unverified.
- GraphQL `podFindAndDeployOnDemand` (create) accepts `cloudType: ALL|SECURE|COMMUNITY, gpuCount, gpuTypeId, minVcpuCount, minMemoryInGb, volumeInGb, containerDiskInGb, imageName, dockerArgs, ports:"8888/http", volumeMountPath, env:[{key,value}], allowedCudaVersions, containerRegistryAuthId, name`. The legacy error from it reads "There are no longer any instances available with the requested specifications. Please refresh and try again." (see §3).

---

## 3. Create a pod

### 3a. REST v2: `POST /v2/pods` (use this)
Source: https://docs.runpod.io/api-reference-v2/pods/create-a-pod.md
"`name` is always required; supply exactly one of `gpu` or `cpu`… `image` is required unless `templateId` is set."

`CreatePodRequest` (`unevaluatedProperties: false`, so unknown fields return 422):
| Field | Type | Default | Notes |
|---|---|---|---|
| `name` | string ≥1 | **required** | |
| `image` | string | required unless `templateId` | e.g. `runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404` |
| `templateId` | string | none | Copied once at create. Body fields override, and `env` merges per key. The pod keeps no link (`template` stays null). An unknown id returns 404. A serverless template returns 422. |
| `gpu` | `CreateGpuConfig` | none | See below |
| `cpu` | `{id, vcpuCount}` | none | CPU pod |
| `cloud` | `SECURE`\|`COMMUNITY` | `SECURE` | No `ALL` in v2 |
| `dataCenterIds` | string[] | `[]` = scheduler chooses | "Preferred data centers for placement" |
| `disk` | int ≥1 | none | container disk GB (ephemeral, wiped on restart) |
| `mounts` | `{persistent?, network?[], global?[]}` | none | **Without `mounts` the pod has NO persistent storage.** In v1 every pod got 20 GB at /workspace. |
| `ports` | string[] `"8888/http"`, `"22/tcp"` | **no default** | v1 defaulted to `8888/http,22/tcp`. List `22/tcp` yourself. |
| `env` | `{KEY: "value"}` | none | |
| `args` | string | none | Raw command string, or JSON `{"entrypoint":[...],"cmd":[...]}` |
| `entrypoint`, `cmd` | string[] | none | Exec form. They encode into `args`. |
| `registry` | string\|null | none | Registry credential id from `/v2/registries` (replaces v1 `containerRegistryAuthId`) |
| `startSsh` | bool | `false` | Injects `PUBLIC_KEY` env with the account's registered keys. **Requires registered keys (`PUT /v2/account/ssh-keys`).** |
| `startJupyter` | bool | `false` | Injects `JUPYTER_PASSWORD` |
| `globalNetworking` | bool | `false` | NVIDIA GPU and an eligible DC only |
| `queue` | `PodQueueOptions` | none | Deploy-when-available, see below |

`CreateGpuConfig` = `BaseGpuConfig` plus extra fields:
| Field | Type | Notes |
|---|---|---|
| `id` | string, **required** | GPU type id |
| `count` | int 1–1024, default 1 | |
| `allowedCudaVersions` | `["12.8","12.6"]` | Exact match. A non-empty list is mutually exclusive with `minCudaVersion` (400). |
| `minCudaVersion` | `"12.1"` | Numeric floor (`major.minor` only, in the body) |
| `minRamPerGpu` | int 1–65536 | "Minimum host system RAM in GB per requested GPU. This is a placement filter, not a resource request. The actual total allocated system RAM may be higher and is returned in gpu.memory." |
| `minVcpuCountPerGpu` | int 1–4096 | Same semantics. Actual value in `gpu.vcpuCount`. |

`Mounts`:
- `persistent: {size ≥10, path}` is host-local and "Deprecated: prefer NetworkMount".
- `network: [{volumeId, path}]` takes at most 4 volumes, "all in the pod's data center". `path` is required, with no default.
- `global: [{volumeId, path?}]` takes at most 1 volume, with no DC constraint.
- `persistent` is mutually exclusive with `network`/`global` (400).

`PodQueueOptions` (`queue`):
- `{}` queues with the defaults.
- Optional `startsAt` (future date-time; the API then skips the initial deploy attempt).
- Optional `expiresAt` (defaults to, and is capped at, 30 days).
- Optional `allowedHours: {monday:[0..23],...}` in UTC. An omitted day is unrestricted, and `[]` blocks the whole day.
- Optional `notifyEmail` (must be an address on the account, otherwise 422).
- Doc rules: "The create call still tries to deploy first; only a capacity failure queues the request… retries about every five minutes, in plan priority order… **GPU pods on the secure cloud only**: `queue` with `cpu` or `globalNetworking` is rejected with `400`. A plan without deploy-when-available is refused with `403`, and one whose queue is full with `409`. A request that matches a pod still queued (same GPU type and count, same settings) returns that queued pod rather than a second one."
- The docs I read do not say which plans include the feature. Test with a real key.

Example body for 8× H100 SXM:
```json
{
  "name": "comp-h100x8",
  "image": "runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404",
  "gpu": { "id": "NVIDIA H100 80GB HBM3", "count": 8, "minRamPerGpu": 100, "minVcpuCountPerGpu": 16 },
  "cloud": "SECURE",
  "dataCenterIds": ["US-KS-2"],
  "disk": 200,
  "mounts": { "network": [ { "volumeId": "agv6w2qcg7", "path": "/workspace" } ] },
  "ports": ["22/tcp", "8888/http"],
  "env": { "HF_TOKEN": "{{ RUNPOD_SECRET_HF_TOKEN }}" },
  "startSsh": true,
  "queue": { "expiresAt": "2026-12-10T00:00:00Z" }
}
```
The env value syntax for secrets is not verified; the docs only say secret keys must start with `RUNPOD_SECRET_`. Drop `env` if unsure.

Responses:
- **`201`**: the `Pod` (see §6), which starts in `PROVISIONING`. "Provisioning is asynchronous… Poll `getPod`."
- **`202`** (only with `queue`): the `QueuedPod`, plus a `Location: /v2/queued-pods/{id}` header.
  - `QueuedPod` fields: `id, status (QUEUED|DEPLOYED|FAILED|EXPIRED|CANCELLED), podId, failureReason (INSUFFICIENT_BALANCE|SPENDING_LIMIT|GPU_QUOTA_EXCEEDED|GPU_CONCURRENCY_EXCEEDED|ORG_RESTRICTED|UNKNOWN), name, image, templateId, gpu{id,count}, cloud, dataCenterIds, queue{startsAt,expiresAt,allowedHours,notifyEmail}, createdAt, resolvedAt`.
  - Poll `GET /v2/queued-pods/{id}`, or list with `GET /v2/queued-pods` (scope `pods:read`; returns `{queuedPods:[...], pagination:{nextCursor, hasNextPage}}`). Cancel with `DELETE /v2/queued-pods/{id}`.
- Error table, verbatim from the doc:

| Status | Meaning | Do |
|---|---|---|
| `422` | The body does not match the contract. `errors` lists each violation. | Fix the request. Never retry. |
| `400` | The body matches the contract but was rejected — either it breaks a cross-field rule, or this GPU and data center combination could not be placed. | Try your next candidate. |
| `402` | Insufficient balance. | Stop; no candidate will succeed. |
| `403` | Your account cannot access the requested pool. | Skip this candidate, keep going. |
| `429` | Rate limited. | Back off using `Retry-After`, then resume. |
| `5xx` | Transient server failure. | Retry the same candidate with backoff. |

Also `404` (unknown templateId), `409` (queue full), and `413` (more than 102400 bytes).

**Error when there is no capacity:** "`400` covers both 'your request breaks a rule' and 'no capacity', because capacity exhaustion currently carries no machine-readable code of its own — only a human-readable `detail`. A rule violation is deterministic, so it fails identically on every candidate: if *every* candidate returns `400`, read the last `detail` as a problem with the request rather than as absent capacity." The docs do not publish the exact v2 `detail` text for no capacity.

**Real legacy messages** (useful as substrings to match if they leak through):
- `"There are no longer any instances available with the requested specifications. Please refresh and try again."` Raised from the SDK `create_pod` (GraphQL) as `runpod.error.QueryError`. https://github.com/runpod/runpod-python/issues/314
- `"This machine does not have the resources to deploy your pod. Please try a different machine."` Third-party report (dev.to, 3 Jun 2026) of a GPU pod launch: https://dev.to/sergeyshmakov/fix-runpods-no-resources-to-deploy-your-pod-error-3gc4

The doc's official pattern: "read-then-create: narrow the catalog to an acceptable (data center, GPU) set, then call this endpoint once per candidate in your order of preference until one returns `201`… treat the catalog as a way to order your candidates, not as a reservation."

### 3b. REST v1 `POST /pods` (RETIRED 15.11.2026; reference only)
Source: https://docs.runpod.io/api-reference/pods/POST/pods.md (the page has no deprecation banner, but the release notes say v1 is retired).

`PodCreateInput` defaults:
- `cloudType` SECURE|COMMUNITY (default SECURE)
- `computeType` GPU|CPU (GPU)
- `gpuTypeIds[]`, `gpuTypePriority` availability|custom
- `gpuCount` 1
- `dataCenterIds[]` (default: all), `dataCenterPriority` availability|custom
- `countryCodes[]`
- `containerDiskInGb` 50, `volumeInGb` 20, `volumeMountPath` /workspace
- `networkVolumeId`
- `ports` default `8888/http,22/tcp`
- `env {}`
- `interruptible` false
- `minRAMPerGPU` 8, `minVCPUPerGPU` 2
- `minDiskBandwidthMBps`, `minDownloadMbps`, `minUploadMbps`
- `allowedCudaVersions` (13.0…11.8)
- `supportPublicIp`, `globalNetworking` false
- `dockerEntrypoint []`, `dockerStartCmd []`
- `locked` false
- `containerRegistryAuthId`, `templateId`, `imageName`
- `name` (default "my pod", max 191)
- `vcpuCount` 2, `cpuFlavorIds`, `cpuFlavorPriority`

v1 responses:
- Pod fields: `id, desiredStatus (RUNNING|EXITED|TERMINATED), costPerHr, adjustedCostPerHr, machine, machineId, publicIp, portMappings, gpu{...}, vcpuCount, memoryInGb, ...`.
- Errors: `{"message": "..."}`.

**v2 has no equivalent for** the multi-GPU fallback in `gpuTypeIds`, `interruptible`/spot, `countryCodes` on create, bandwidth/`supportPublicIp` filters, `machineId`/`podHostId`, or the `reset` action (per the migration guide).

---

## 4. Network volumes (v2)
Sources: https://docs.runpod.io/api-reference-v2/network-volumes/create-a-network-volume.md, https://docs.runpod.io/storage/network-volumes.md
- `GET /v2/network-volumes` returns `{ "networkVolumes": [...] , "pagination": {...} }`. Pagination: follow `pagination.nextCursor` until `hasNextPage` is false, up to 1000 per page.
- `POST /v2/network-volumes` (scope `volumes:write`) takes the body `{ "name": "training-dataset", "dataCenter": "US-KS-2", "size": 50, "type": "HIGH_PERFORMANCE" }`.
  - `name`, `size` (10–4096 GB) and `dataCenter` are required. `type` is optional: `STANDARD`|`HIGH_PERFORMANCE`, using the DC default if omitted, and immutable once set.
  - The v1 field `dataCenterId` was renamed to **`dataCenter`**.
  - Returns `201 {id, name, size, dataCenter, type}`.
- `GET/PATCH/DELETE /v2/network-volumes/{id}` also exist. Size can grow but not shrink.
- **Constraint:** "Every network volume must be in the pod's data center". The doc also says "Network volumes are only available for Pods in the Secure Cloud."
- **Doc contradiction:** the storage page says volumes "must be attached during Pod deployment. They cannot be attached or detached later". The v2 schema mentions `UpdatePodMounts` (mount, move or unmount after creation), while the migration guide says "The mount type is fixed at creation". Assume attach-at-create.
- **Sniper consequence:** a network volume pins the pod to one DC. That cuts the candidates for 8×H100 sharply. Either create volumes in 2–3 DCs, or skip the volume and pull models at boot. A Global Volume (`/v2/global-volumes`, usage-billed, no DC pin) is the alternative.
- Pricing:
  - Standard: $0.07/GB/month under 1 TB, $0.05/GB/month over 1 TB, billed hourly.
  - High-performance: $0.14/GB/month (runpod.io/pricing).
  - Charges continue while pods are stopped. At a $0 balance, a volume "may eventually be terminated".

---

## 5. Templates, SSH
- `GET /v2/templates` lists your own templates, `{templates:[...], pagination}`. `GET /v2/templates/{id}` fetches any template, catalog or owned.
- `GET /v2/catalog/templates?source=official|verified|community` (scope `catalog:read`) returns at most 100 entries with no pagination.
  - Doc example entry: `{ "id": "30zmvf89kd", "name": "PyTorch 2.8", "image": "runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404", "ports": ["8888/http","22/tcp"], "startSsh": true, "startJupyter": true, "category": "NVIDIA", "serverless": false }`.
  - Treat `30zmvf89kd` as a doc example and resolve the live id by calling `source=official` and filtering on `name` containing "PyTorch". Or skip `templateId` entirely and pass `image` + `ports` + `startSsh`, which is simpler and more deterministic.
  - Official image tags look like `runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404` (CUDA 12.8.1, torch 2.8.0, Ubuntu 24.04). Make sure the host CUDA is ≥ the image CUDA: use `gpu.minCudaVersion: "12.8"`.
- **SSH** (https://docs.runpod.io/pods/configuration/use-ssh.md, plus the `PodSsh` schema):
  1. Register keys with `PUT /v2/account/ssh-keys` `{ "keys": ["ssh-ed25519 AAAA... me@x"] }`. This is a **full replace**, scope `authentication:write`. "Keys apply to pods created afterward with `startSsh`. Running pods are not updated." The console Credentials page also works.
  2. Create the pod with `"startSsh": true`, which injects env `PUBLIC_KEY`. To use a different key for one pod, set env `SSH_PUBLIC_KEY` (use-ssh doc) or pass `PUBLIC_KEY` in `env` yourself. The schema says the API injects it "unless the request already sets one".
  3. Proxy connection: `pod.ssh.proxy` = `{host:"ssh.runpod.io", port:22, username:"<podId>-<hash>", command}`. It needs no open port and no public IP, but it is an interactive shell only (no SCP/SFTP/rsync/port forwarding).
  4. Direct connection: `pod.ssh.direct` = `{host:<public IP>, port:<mapped>, username:"root", command:"ssh root@IP -p PORT"}`. It needs `"22/tcp"` in `ports` and a running pod with a public port mapping. It is **null in list responses**, so fetch `GET /v2/pods/{id}`. Inside the pod the mapping is visible as `RUNPOD_PUBLIC_IP` and `RUNPOD_TCP_PORT_22`.
  - Official images start sshd from `PUBLIC_KEY`. A custom image must install and start `openssh-server` itself. The doc gives a bash start-command snippet.
- Pods support only TCP and HTTP. "Pods only support TCP and HTTP connections" (no UDP).

---

## 6. Pod lifecycle (v2)
Sources: the create-a-pod page, https://docs.runpod.io/api-reference-v2/pods/trigger-a-pod-state-transition.md, and the migration guide.

Endpoints:
- `GET /v2/pods` returns `{pods:[...], pagination}` with up to 1000 per page. Query filters are ignored, so filter client-side. `runtime` and `ssh.direct` are null in the list. Cluster pods are excluded unless `includeClusterPods=true`.
- `GET /v2/pods/{id}` returns the full pod, including `runtime` (uptime, gpus util, ports `{private, public, type, ip}`).
- `PATCH /v2/pods/{id}` updates a pod.
- `POST /v2/pods/{id}/action` takes `{"action":"start"|"stop"|"restart"|"terminate"}` (scope `pods:write`).
  - start, stop and restart return `200` + Pod. `terminate` returns `204`. An invalid transition returns `409`.
  - Allowed actions per status: RUNNING → stop/restart/terminate. EXITED/ERROR → start/terminate. PROVISIONING/STARTING → stop/terminate.
  - The pod's `actions[]` field lists the currently valid ones.
- `DELETE /v2/pods/{id}` terminates the pod.
- Also available: `GET /v2/pods/{id}/logs` (stream) and a "run a command in a pod" endpoint.

`PodStatus` values:
- `PROVISIONING` (being allocated)
- `STARTING` (container starting)
- `RUNNING` (container healthy)
- `EXITED` (stopped)
- `ERROR`
- `TERMINATED`

`Pod` fields:
- Required: `id, name, status, actions, image, args, disk, mounts, ports, env, registry, cloud, dataCenterId, cudaVersion, ssh, template, cost, locked, runtime, createdAt, startedAt, globalNetworking`.
- Optional: `gpu{id,count,vcpuCount,memory}` (totals across all GPUs), `cpu`, `cluster`, `costCenter`, `tags`.
- `cost` is the hourly USD compute rate. "a stopped pod isn't billed for compute, only for its volume disk."

Billing (https://docs.runpod.io/pods/pricing.md):
- "Pods are billed by the second for compute and storage, with no fees for data ingress or egress."
- Container disk is $0.10/GB/month while running and not charged when stopped.
- Volume disk is **$0.10/GB/month running and $0.20/GB/month stopped**.
- Network volumes cost $0.07 (under 1 TB) or $0.05 (over 1 TB) per GB per month.

**Stop risk:** a stopped pod keeps its machine but releases the GPUs. On restart the GPUs may be taken ("Zero GPU Pods"), and the v2 "REST API's `start` action returns an error in this case" (https://docs.runpod.io/pods/troubleshooting/zero-gpus.md). **For a scarce 8×H100, do NOT stop between sessions.** Keep the pod running, or terminate it and keep data on a network volume.

---

## 7. System RAM and vCPU per GPU for H100 SXM
- runpod.io/pricing (scraped 20.11.2026) shows the H100 SXM card as **80 GB VRAM, 125 GB RAM, 20 vCPUs** (per GPU), at **$4.39/hr**.
  - FAQ: "Runpod rents the H100 SXM at $4.39/hr on Secure Cloud, or from $2.69/hr on Community Cloud".
  - The card does not label which cloud its RAM/vCPU figures are for. They match the Secure price, so treat them as the Secure figure. Community RAM/vCPU varies by host and is not published.
  - Other cards, as I read them (per GPU, secure $/h): H100 PCIe 188 GB/16 vCPU $2.89. H100 NVL 94 GB/16 vCPU $3.19. H200 276 GB/24 vCPU $5.29. B200 283 GB/28 vCPU $7.99. A100 SXM 125 GB/16 vCPU $2.19. The card-to-price mapping in the scrape was messy, so **read the live `price.secure/community` from the catalog.**
- Live truth for an 8× config comes from `GET /v2/catalog/gpus/NVIDIA%20H100%2080GB%20HBM3?include=AVAILABILITY&product=POD&count=8&cloud=SECURE|COMMUNITY`. `minRam` and `minVcpuCount` give the **minimum totals** across matching machines. After creation, `pod.gpu.memory` and `pod.gpu.vcpuCount` are the totals actually allocated.
- `gpu.minRamPerGpu` and `gpu.minVcpuCountPerGpu` are **placement filters only** ("not a resource request"). They exclude smaller hosts but do not add RAM, and the host's allocation "may be higher". Setting them too high just yields capacity 400s.
- **No Docker inside a pod:** "Runpod runs Docker for you, so you cannot spin up your own Docker instance" (Docker Compose not supported; https://docs.runpod.io/pods/overview.md). There is no privileged mode, and only TCP/HTTP. Plan on a single container image: vLLM/SGLang directly in the image, or pip-install at boot.
- Community Cloud: "Runpod is no longer accepting new hosts for Community Cloud" (existing capacity remains). Network volumes are Secure-only.

---

## 8. Gotchas for a sniper
1. **Availability levels** (`NONE|LOW|MEDIUM|HIGH`) are coarse, per product, per `count` and per `cloud`. They are a hint for ordering candidates, not a reservation. A create can still return a capacity 400 right after HIGH. Always pass `count=8`, because availability for 1 GPU says nothing about an 8-GPU machine. `maxCount.secure` must be ≥ 8 to bother at all.
2. **Creation is all-or-nothing per request.** One pod runs on one machine (`maxCount` = "the GPU count of the largest machine"), so there is no partial 5-of-8 grant. The outcomes are 201 (full pod), 400 (no placement) or 202 (queued). After a 201, the pod can still end in `ERROR` (image pull and the like), so poll `GET /v2/pods/{id}` until `RUNNING`.
3. **Duplicate safety:** on a timeout or 5xx after POST, `GET /v2/pods` and match `name` before retrying. Queue requests are idempotent per identical settings.
4. **Spot/interruptible is gone** in v2, and GraphQL `minimumBidPrice` says "Spot pods are no longer offered". Savings plans are deprecated. Only on-demand remains.
5. **Money gates, checked at create/resume:**
   - **Minimum balance:** "you must have at least one hour's worth of credits for your selected configuration". For 8×H100 SXM Secure that is about 8 × $4.39 ≈ **$35.12** plus storage. Keep a healthy margin or turn on auto-pay; it runs at most once per hour.
   - **Spend limit:** "Default limit of $80/hour across all resources". It rises automatically with history, or contact support. 8×H100 SXM Secure ≈ $35/h fits; 8×B200 at $7.99 ≈ $64/h fits, but barely, alongside other resources.
   - Check both before sniping with `GET /v2/account/limits` → `{spendRate:{limit, current}, serverlessWorkers:{limit}}` and `GET /v2/billing/balance` → `{balanceAmount, billingMode: PREPAID|POSTPAID}`.
   - A short balance returns `402`. Queued pods fail with `INSUFFICIENT_BALANCE` / `SPENDING_LIMIT` / `GPU_QUOTA_EXCEEDED` / `GPU_CONCURRENCY_EXCEEDED`, which shows per-GPU-type quotas and plan GPU concurrency caps exist (values not published).
   - At a $0 balance, pods stop. Pods without a network volume are **terminated** and lose their data.
6. **v2 defaults bite:** no default `ports` (add `22/tcp`), no default persistent storage (add `mounts`), `cloud` defaults to SECURE, no `ALL`, and unknown fields return 422.
7. **CUDA:** constraining `allowedCudaVersions` to a version no free machine reports turns into a capacity error. Check `cudaVersions[].available` in the catalog, or use `minCudaVersion`.
8. **Rate limits are shared** by every `/v2` call (catalog polling + create + pod polling). Parse `RateLimit` and slow down when `minute` `r` is low.
9. **Network volume ⇒ single DC.** It also forces Secure Cloud.
10. **Instant Clusters** (`product=CLUSTER`, `/v2/clusters`) are a separate multi-node product. For a single 8×H100 node, use pods.

Sniper loop (TypeScript sketch):
```ts
const H = { Authorization: `Bearer ${env.RUNPOD_API_KEY}`, "Content-Type": "application/json" };
const gpu = encodeURIComponent("NVIDIA H100 80GB HBM3");
const r = await fetch(`https://api.runpod.io/v2/catalog/gpus/${gpu}?include=AVAILABILITY&product=POD&count=8&cloud=SECURE`, { headers: H });
const t = await r.json(); // t.availability, t.dataCenters?: {id,name,availability}[], t.minRam, t.minVcpuCount, t.price.secure
const dcs = (t.dataCenters ?? []).filter(d => d.availability !== "NONE")
  .sort((a, b) => ({ HIGH: 0, MEDIUM: 1, LOW: 2 } as any)[a.availability] - ({ HIGH: 0, MEDIUM: 1, LOW: 2 } as any)[b.availability]);
for (const dc of dcs) {
  const res = await fetch("https://api.runpod.io/v2/pods", { method: "POST", headers: H, body: JSON.stringify({
    name: "comp-h100x8", image: "runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404",
    gpu: { id: "NVIDIA H100 80GB HBM3", count: 8 }, cloud: "SECURE", dataCenterIds: [dc.id],
    disk: 200, ports: ["22/tcp"], startSsh: true }) });
  if (res.status === 201) return await res.json();      // Pod
  if (res.status === 202) return await res.json();      // QueuedPod (only if "queue" sent)
  if (res.status === 402 || res.status === 422) throw new Error(await res.text()); // stop
  if (res.status === 429) { /* sleep Retry-After */ }
  // 400 / 403 → next candidate; 5xx → retry same with backoff
}
```

---

## Sources
- https://docs.runpod.io/llms.txt
- https://docs.runpod.io/api-reference-v2/overview.md
- https://docs.runpod.io/api-reference-v2/rate-limits.md
- https://docs.runpod.io/api-reference-v2/migrate-from-v1.md
- https://docs.runpod.io/api-reference-v2/catalog/list-gpu-types.md
- https://docs.runpod.io/api-reference-v2/catalog/get-a-gpu-type.md
- https://docs.runpod.io/api-reference-v2/catalog/list-data-centers.md
- https://docs.runpod.io/api-reference-v2/catalog/list-public-templates.md
- https://docs.runpod.io/api-reference-v2/pods/create-a-pod.md
- https://docs.runpod.io/api-reference-v2/pods/trigger-a-pod-state-transition.md
- https://docs.runpod.io/api-reference-v2/pods/list-queued-pods.md
- https://docs.runpod.io/api-reference-v2/network-volumes/create-a-network-volume.md
- https://docs.runpod.io/api-reference-v2/account/get-account-limits.md
- https://docs.runpod.io/api-reference-v2/account/replace-registered-ssh-public-keys.md
- https://docs.runpod.io/api-reference-v2/account/get-your-account.md
- https://docs.runpod.io/api-reference-v2/billing/get-the-account-balance.md
- https://docs.runpod.io/api-reference/pods/POST/pods.md (v1, retired)
- https://docs.runpod.io/release-notes.md
- https://docs.runpod.io/get-started/credentials.md
- https://docs.runpod.io/references/gpu-types.md
- https://docs.runpod.io/pods/pricing.md
- https://docs.runpod.io/pods/overview.md
- https://docs.runpod.io/pods/choose-a-pod.md
- https://docs.runpod.io/pods/configuration/use-ssh.md
- https://docs.runpod.io/pods/troubleshooting/zero-gpus.md
- https://docs.runpod.io/storage/network-volumes.md
- https://docs.runpod.io/accounts-billing/billing.md
- https://docs.runpod.io/sdks/graphql/manage-pods.md
- https://docs.runpod.io/sdks/graphql/configurations.md
- https://graphql-spec.runpod.io/ (via a search index; direct fetch timed out)
- https://www.runpod.io/pricing
- https://runpod.io/blog/deploy-when-available-is-now-ga
- https://github.com/runpod/runpod-python/issues/314
- https://dev.to/sergeyshmakov/fix-runpods-no-resources-to-deploy-your-pod-error-3gc4

Not verified (no live API call was possible: the sandbox proxy blocks rest.runpod.io and docs.runpod.io):
- the exact v2 `detail` text for no capacity
- the scope for `POST /v2/pods`
- which plans allow `queue`
- the live official PyTorch template id
- community-cloud RAM/vCPU per H100
- `GpuTypeDataCenterAvailability` subfields
