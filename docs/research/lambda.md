# Lambda Cloud API — research for a capacity sniper (Cloudflare Worker, plain fetch)

Researched 2026-11-20. **Primary source: the official OpenAPI spec v1.10.0**, downloaded from the
"Download OpenAPI spec" link on https://docs.lambda.com/api/cloud →
`https://docs.lambda.com/api/cloud/spec.json` (a local copy is saved next to this file as
`lambda-cloud-openapi-1.10.0.json`). Everything marked **[spec]** was read directly from that JSON
(field names, enums, constraints, error `code` constants and default `message` strings).
**[docs]** = docs.lambda.com prose pages; **[real code]** = public GitHub code;
**[inference]** = my conclusion, not stated by Lambda.

Note on the fetched spec: the scraper removed text inside angle brackets, so placeholders like
`<API-KEY>` show up empty in some descriptions. Field names and enums are not affected.

---

## 1. Base URL, auth, rate limits, error format

### Base URLs [spec `servers`]
| URL | Status |
|---|---|
| `https://cloud.lambda.com/` | "Production server" (current) |
| `https://cloud.lambda.ai/` | "Secondary production server (deprecated)" |
| `https://cloud.lambdalabs.com/` | "Tertiary production server (deprecated)" |

All paths are under `/api/v1/...`, e.g. `https://cloud.lambda.com/api/v1/instance-types`.
Older real-world scripts still call `cloud.lambdalabs.com` / `cloud.lambda.ai`, which still work but are
marked deprecated. **Use `cloud.lambda.com`.**

### Authentication [spec `securitySchemes`, `security: [{bearerAuth}, {basicAuth}]`]
- Recommended: `Authorization: Bearer <API_KEY>`
- Backward-compatible: HTTP Basic with the API key as the username and an empty password:
  `Authorization: Basic base64("<API_KEY>:")` (that is curl `-u <API_KEY>:`).
- "If you make a request without including a supported `Authorization` header, the request will fail."
- Keys are created at https://cloud.lambda.com/api-keys.

### Rate limits [spec `info.description`]
> "Requests to the API are generally limited to one request per second. Requests to the
> `/instance-operations/launch` endpoint are limited to one request per 12 seconds, or five requests per minute."

The spec also says the limit "is enforced at the edge and is not part of the API contract", so the
exact algorithm (window or bucket, per key or per account) is **not published**. Treat 1 rps as shared
by all calls from your key, and the launch limit as separate: at most 1 launch per 12 s.

### 429 shape [spec `ApiErrorRateLimited`]
HTTP 429, body:
```json
{
  "error": {
    "code": "global/rate-limited",
    "message": "Too many requests. Retry after the interval given in the Retry-After response header.",
    "suggestion": "Wait for the interval in the Retry-After header, then retry the request. Reduce the rate of concurrent requests if this recurs.",
    "request_id": "..."
  }
}
```
These are the spec's default `message`/`suggestion` values. Honour the `Retry-After` header. Real
clients parse it as whole seconds [real code: komira-ai/jobscheduler `error.rs`].

### Envelope [spec]
- Success: `{ "data": <endpoint-specific> }` (some list endpoints add top-level fields, e.g. `page_token`).
- Error: `{ "error": { "code": string, "message": string, "suggestion"?: string, "request_id"?: string } }`
- Lambda: "avoid relying on the values of `message` or `suggestion`, as these values are subject to change. Instead, use the value of `code`."
- Upstream errors have codes prefixed `provider/`, e.g.
  `{"error":{"code":"provider/internal-unavailable","message":"Provider unavailable","suggestion":"Try again shortly"}}`.
- Other global codes in the spec: `global/internal-error` ("An internal server error occurred."), `global/conflict`, `global/duplicate`, `global/forbidden`, `global/not-found`, `global/object-does-not-exist`.

### Practical header note [real code]
freesolo-co/flash `client.py`: "Cloudflare in front of the API 403s Python's default urllib User-Agent,
so a real one is always sent". **Always send an explicit `User-Agent` from the Worker**, plus
`Accept: application/json` and `Content-Type: application/json` on POST.

---

## 2. `GET /api/v1/instance-types` (operationId `listInstanceTypes`)

"Retrieves a list of the instance types currently offered on Lambda's public cloud, as well as details
about each type. Details include resource specifications, pricing, and regional availability." [spec]

Query params: `workspace_id` (string, optional): "The unique identifier (ID) of the workspace to filter by". No other params.

### Response schema [spec `InstanceTypes`, `InstanceTypesItem`, `InstanceType`, `InstanceTypeSpecs`, `Region`]
`data` is an **object (map) keyed by instance-type name**, not an array:
```
data: {
  [instance_type_name: string]: {
    instance_type: {                      // required: all of these fields
      name: string,                       // e.g. "gpu_8x_h100_sxm5gdr"
      description: string,                // e.g. "8x H100 (80 GB SXM5)"
      gpu_description: string,            // e.g. "H100 (80 GB SXM5)"
      price_cents_per_hour: integer,      // US cents per hour for the WHOLE instance, e.g. 3592
      specs: { vcpus: int, memory_gib: int, storage_gib: int, gpus: int },  // all required
      architecture: "x86_64" | "arm64"    // InstanceTypeArchitecture enum
    },
    regions_with_capacity_available: [ { name: string, description: string } ]  // required; [] = no capacity anywhere
  }
}
```
Spec example:
```json
{
  "data": {
    "gpu_8x_example": {
      "instance_type": {
        "name": "gpu_8x_example",
        "description": "8x Example GPU (40 GB SXM4)",
        "gpu_description": "Example GPU (40 GB SXM4)",
        "price_cents_per_hour": 1592,
        "specs": { "vcpus": 124, "memory_gib": 1800, "storage_gib": 6144, "gpus": 8 },
        "architecture": "x86_64"
      },
      "regions_with_capacity_available": [ { "name": "us-west-1", "description": "California, USA" } ]
    }
  }
}
```
Field examples in the spec: `name` "gpu_8x_h100_sxm5gdr", `price_cents_per_hour` 3592, `specs`
`{vcpus: 208, memory_gib: 1800, storage_gib: 24780, gpus: 8}`.
Errors: 400 `global/invalid-parameters`, 401 `global/invalid-api-key`, 403 `global/account-inactive`, 404 `global/not-found`, 429 `global/rate-limited`.

### Known instance type names (API identifiers)
Lambda's docs page lists hardware but **not** the API identifiers. The names below come from
the SkyPilot catalog (`skypilot-org/skypilot-catalog/catalogs/v8/lambda/vms.csv`, which is
generated from this API), Lambda's own support script (`lambdal-support/lambda-public-tools/launch_instance.py`, 2024),
real sniper code (2026), and spec examples. Prices are the SkyPilot snapshot, per instance-hour in USD.
**Read live prices from `price_cents_per_hour`.**

| API name | GPUs | vCPU / RAM GiB (catalog) | $/h (catalog) | Notes |
|---|---|---|---|---|
| `gpu_8x_b200_sxm6` | 8× B200 180 GB | 208 / 2900 | 61.52 (= $7.69/GPU, matches lambda.com/pricing) | used by real snipers 2026 |
| `gpu_8x_b200_1800gib_e` | 8× B200 | 208 / 1800 | 61.52 | variant, catalog only |
| `gpu_2x_b200_sxm6` | 2× B200 | 52 / 720 | 15.78 | |
| `gpu_1x_b200_sxm6` | 1× B200 | 26 / 360 | 7.99 | |
| (4× B200) | 4× B200 | 104 / 1440 [docs] | n/a | docs list a 4× B200 config; the name `gpu_4x_b200_sxm6` appears in real code (hcltech DEFAULT_PRIORITY) but not in the catalog |
| `gpu_8x_h100_sxm5` | 8× H100 80 GB SXM | 208 / 1800 | 36.72 (= $4.59/GPU, matches pricing page) | the main 8×H100 target |
| `gpu_8x_h100_sxm5gdr` | 8× H100 SXM5 | 208 / 1800, 24780 GiB storage [spec example] | 35.92 [spec example] | spec example only; likely a GPUDirect-RDMA variant [inference] |
| `gpu_8x_h100_sxm5raidz1` | 8× H100 | n/a | n/a | in Lambda's 2024 support script (us-south-2) |
| `gpu_4x_h100_sxm5` | 4× H100 | 104 / 900 | 18.76 | |
| `gpu_2x_h100_sxm5` | 2× H100 | 52 / 450 | 9.58 | |
| `gpu_1x_h100_sxm5` | 1× H100 SXM | 26 / 225 | 4.89 | |
| `gpu_1x_h100_pcie` | 1× H100 PCIe | 26 / 200 | 3.79 | |
| `gpu_1x_gh200` | 1× GH200 96 GB | 64 / 432 | 2.59 | **arm64**; only 1× exists |
| `gpu_8x_a100_80gb_sxm4` | 8× A100 80 GB | 240 / 1800 | 25.52 (= $3.19/GPU) | |
| `gpu_8x_a100` | 8× A100 40 GB SXM | 124 / 1800 | 15.92 (= $1.99/GPU) | |
| `gpu_4x_a100`, `gpu_2x_a100`, `gpu_1x_a100` | A100 40 GB PCIe | — | 7.96 / 3.98 / 1.99 | |
| `gpu_1x_a100_sxm4` | 1× A100 40 GB SXM | 30 / 200 | 1.99 | |
| `gpu_8x_v100` / `gpu_8x_v100_n` | 8× V100 16 GB | 92 or 88 / 448 | 6.32 | |
| `gpu_1x_a10`, `gpu_{1,2,4}x_a6000`, `gpu_1x_rtx6000` | small GPUs | — | 1.29 / 1.09–4.36 / 0.69 | |
| `cpu_4x_general` | CPU only | 4 / 16 | 0.20 | |

- **H200: none found** on Lambda's on-demand lists (docs table, pricing page, catalog). No `h200` type name was found anywhere.
- Docs hardware table (docs.lambda.com/public-cloud/on-demand/, "as of December 2025"): B200 8/4/2/1×; GH200 1×; H100 SXM 8/4/2/1×; H100 PCIe 1×; A100 SXM 80 GB 8×; A100 SXM 40 GB 8/1×; A100 PCIe 4/2/1×; A10; A6000 4/2/1×; V100 8×; RTX 6000 1×.
- lambda.com/pricing today (per GPU-hour, "plus applicable sales tax/VAT/GST"): HGX B200 $7.69, HGX H100 $4.59, HGX A100 80 GB $3.19, A100 40 GB $1.99, V100 $0.79.
- SkyPilot's catalog README warns that the catalog "assumes each instance type is offered in every region ... (and it is not)", so its region list is **not** availability data.
- The response can include types the account cannot launch, and names change over time (e.g. `_sxm5gdr`, `_1800gib_e`). **Match on `instance_type.specs.gpus` plus `gpu_description` / name prefix** rather than hard-coding one exact name [inference].

---

## 3. Regions

**Endpoint exists:** `GET /api/v1/regions` (operationId `listRegions`), no params [spec]. Returns
`data: [{ name: string, description: string }]`. Errors: 401, 403 `global/account-inactive`, 404, 429.

Region names:
- Docs (on-demand overview) list 15: `asia-northeast-1` (Tokyo), `asia-northeast-2` (Osaka), `asia-south-1` (India), `europe-central-1` (Germany), `me-west-1` (Israel), `us-east-1` (Virginia), `us-east-2` (Washington DC), `us-midwest-1` (Illinois), `us-south-1` (Texas), `us-south-2` (North Texas), `us-south-3` (Central Texas), `us-west-1` (California), `us-west-2` (Arizona), `us-west-3` (Utah), `us-west-4` (S. California).
- Also seen in the API-derived SkyPilot catalog and real code: `australia-east-1`, `europe-south-1`, `us-east-3`. A real hunter logged 8× B200 stock in `australia-east-1` on 2026-07-21 (RightNow-AI/inkling-turbo `grab_8x_gates.py`).
- **Don't hard-code the list.** Take regions from `regions_with_capacity_available` or `GET /regions`.
- Firewall rules "do not apply to the **us-south-1** region" [spec]. Filesystems in us-south-1 are capped at 10 TB [docs].

---

## 4. Launch — `POST /api/v1/instance-operations/launch` (operationId `launchInstance`)

"Launches a Lambda On-Demand Cloud instance." Rate limit: 1 per 12 s / 5 per min.

### Request body [spec `InstanceLaunchRequest`]
Required: `region_name`, `instance_type_name`, `ssh_key_names`. The schema has **no** `additionalProperties:false`.

| Field | Type / constraint | Notes (spec wording) |
|---|---|---|
| `region_name` | string, **required** | "The region into which you want to launch the instance." |
| `instance_type_name` | string, **required** | example `"gpu_8x_a100"` |
| `ssh_key_names` | string[], **required** | "**Currently, exactly one SSH key must be specified.**" Use key *names*, not IDs. |
| `file_system_names` | string[] | names of filesystems to mount at the default path; example `["my-filesystem"]` or `[]` |
| `file_system_mounts` | `[{ mount_point: string, file_system_id: string }]` | both required; `mount_point` maxLength 256, pattern `^(/home\|/lambda/nfs\|/data)[//a-zA-Z0-9-]*$`; if a filesystem is in both lists, the path from `file_system_mounts` wins |
| `hostname` | string 1–63, pattern `^[a-z0-9][0-9a-z-]{0,62}$` | written into /etc/hostname; default is an IP-based name |
| `name` | string 0–64 | display name |
| `image` | `{ id: string }` **or** `{ family: string }` (`ImageSpecificationID` / `ImageSpecificationFamily`) | "Defaults to the latest Lambda Stack image." |
| `user_data` | string, plain text, ≤ 1 MB | cloud-init user-data |
| `tags` | `[{ key, value }]` | key maxLength 55, pattern `^[a-z][a-z0-9-:]+$` (keys starting `lambda-ai-` are reserved); value maxLength 128 |
| `firewall_rulesets` | `[{ id: string }]` | "must exist in the same region as the instance" |
| `workspace_id` | string | creates the instance in that workspace |

- **No `quantity` field** exists in spec 1.10.0, nor in the older 1.9.3 spec (jentic mirror). Lambda's 2024 support script and several 2026 snipers still send `"quantity": 1`, and it is evidently tolerated because the schema is not closed [real code + inference]. **Don't send it.** One launch = one instance.
- Example request:
```json
{
  "region_name": "us-east-1",
  "instance_type_name": "gpu_8x_h100_sxm5",
  "ssh_key_names": ["sniper-key"],
  "name": "sniper-8xh100",
  "image": { "family": "lambda-stack-22-04" },
  "tags": [{ "key": "owner", "value": "sniper" }]
}
```

### Response [spec `InstanceLaunchResponse`]
```json
{ "data": { "instance_ids": ["0920582c7ff041399e34823a0be62549"] } }
```
`instance_ids` (required, string[]): "The unique identifiers (IDs) of the launched instances."

### Launch error codes [spec — complete list]
| HTTP | `error.code` | Default message (spec) |
|---|---|---|
| 400 | `instance-operations/launch/insufficient-capacity` | "Not enough capacity to fulfill launch request." |
| 400 | `instance-operations/launch/file-system-in-wrong-region` | — |
| 400 | `instance-operations/launch/file-system-not-in-vpc` | — |
| 400 | `global/invalid-parameters` | "Invalid request data." |
| 400 | `global/object-does-not-exist` (ApiErrorLaunchResourceNotFound; e.g. bad key/type/filesystem name) | message = the resource not found; `suggestion` required |
| 400 | `global/quota-exceeded` | "Quota exceeded." / suggestion "Contact Support to increase your quota." |
| 401 | `global/invalid-api-key` | "API key was invalid, expired, or deleted." |
| 403 | `global/account-inactive` | "Your account is inactive." / "Make sure you have verified your email address and have a valid payment method. Contact Support if problems continue." |
| 403 | `global/invalid-address` | "Your billing address is invalid." |
| 404 | `global/object-does-not-exist` | — |
| 429 | `global/rate-limited` | see §1 |

Insufficient-capacity message as seen in the wild (SkyPilot catalog README, quoting a real response):
`"Not enough capacity to fulfill launch request. Regions with capacity available: us-west-3"`, so the
message can name other regions that have capacity. Lambda says not to parse `message`, but it is a useful hint to log.

How real snipers classify errors (KMKoushik/lambda-gpu-snatcher `index.ts`):
- **Fatal (stop):** `global/invalid-api-key`, `global/invalid-parameters`, `global/invalid-address`, `global/object-does-not-exist`, `global/not-found`, `global/quota-exceeded`, `instance-operations/launch/file-system-in-wrong-region`.
- **Capacity miss (keep hunting):** `instance-operations/launch/insufficient-capacity`.
- Defaults there: poll 15 000 ms; launch cooldown 12 000 ms.

---

## 5. Instances

### `GET /api/v1/instances` ("List running instances") [spec]
Query params: `page_size` (int 1–100, default 50), `page_token` (string), `cluster_id` (string), `workspace_id` (string).
"Pagination is opt-in. If you send neither `page_size` nor `page_token`, the response contains every
instance, oldest first, and `page_token` is null. If you send either, results are paged newest first."
Response: `{ "data": Instance[], "page_token": string | null }` (both required).
Errors: 400, 401, 403 (`global/account-inactive`, `global/forbidden`), 404 `global/not-found`, 429.

### `GET /api/v1/instances/{id}` [spec]
Returns `{ data: Instance }`. 404 `global/object-does-not-exist` ("Specified instance does not exist.").

### `POST /api/v1/instances/{id}` (update) [spec]
Body: `name` (0–64), `tags` (`RequestedTagEntry[]`). Tags replace the existing ones; `[]` clears them; omit to leave them unchanged. Returns `Instance`.

### `Instance` schema [spec]
Required: `id`, `status`, `ssh_key_names`, `file_system_names`, `region`, `instance_type`, `first_healthy`, `actions`.
| Field | Type |
|---|---|
| `id` | string |
| `name` | string (0–64), optional |
| `ip` | string, public IPv4 (absent until assigned) |
| `private_ip` | string |
| `status` | `InstanceStatus` enum: **`booting`, `active`, `unhealthy`, `terminated`, `terminating`, `preempted`** |
| `ssh_key_names` | string[] |
| `file_system_names` | string[] |
| `file_system_mounts` | `[{mount_point, file_system_id}]`; missing if nothing is mounted |
| `region` | `{name, description}` |
| `instance_type` | full `InstanceType` object (incl. `price_cents_per_hour`) |
| `workspace_id` | string |
| `image` | `{id, family}`; absent once it can't be resolved (e.g. terminated) |
| `hostname` | string |
| `jupyter_token` | string |
| `jupyter_url` | string, e.g. `https://jupyter-<id>.lambdaspaces.com/?token=...` |
| `first_healthy` | ISO date-time or `null` ("When the instance first became healthy, or null if it never has.") |
| `actions` | `{migrate, rebuild, restart, cold_reboot (deprecated), power_cycle, terminate}`, each `{available: bool, reason_code?, reason_description?}`; `reason_code` enum: `vm-has-not-launched`, `vm-is-too-old`, `vm-is-terminating`, `vm-action-in-progress`, `vm-action-unavailable-bare-metal`, `vm-action-unavailable-virtualized` (or another string) |
| `tags` | `[{key, value}]` |
| `firewall_rulesets` | `[{id}]` |

### `POST /api/v1/instance-operations/terminate` [spec]
Body `{ "instance_ids": ["..."] }` (required). Response `{ data: { terminated_instances: Instance[] } }`.
Errors: 400, 401, 403, 404 `global/object-does-not-exist`, 429.

### `POST /api/v1/instance-operations/restart` [spec]
Body `{ "instance_ids": ["..."] }`. Response `{ data: { restarted_instances: Instance[] } }`.
Errors: 400, 401, 403, 404, **409 `global/conflict`** ("The request conflicts with the current state of the resource."), 429.

Docs: "At the moment, Lambda Cloud instances can only be launched, restarted, or terminated." There is
no stop/pause. "Instances might take several minutes to launch."

---

## 6. SSH keys [spec]
- `GET /api/v1/ssh-keys` (`workspace_id` optional) → `data: SSHKey[]`.
- `POST /api/v1/ssh-keys` body `AddSSHKeyRequest`: `name` (**required**, 1–64), `public_key` (1–4096; **omit it to have Lambda generate a key pair**), `workspace_id` (optional; defaults to the account's default workspace).
  Response `data` is `GeneratedSSHKey` (with `private_key`) or `SSHKey`. "Lambda doesn't store your private key after it's been generated."
- `DELETE /api/v1/ssh-keys/{id}` → `data: {}` (EmptyResponse).
- `SSHKey`: `id`, `name`, `public_key` (required), `workspace_id`. `GeneratedSSHKey` adds `private_key` (e.g. `"-----BEGIN RSA PRIVATE KEY-----\n...`).
- Errors (all three): 400 `global/invalid-parameters`, 401, 403 `global/account-inactive`, 404 `global/not-found`, 429.
- **Launch takes the key `name`**, and exactly one.

---

## 7. Filesystems [spec + docs]
- `GET /api/v1/filesystems` (`workspace_id` optional) → `data: Filesystem[]`. The old path `GET /api/v1/file-systems` is deprecated but "not scheduled for removal".
- `POST /api/v1/filesystems` body: `name` (**required**, 1–60, pattern `^[a-zA-Z]+[0-9a-zA-Z-]*$`), `region` (**required**, e.g. `"us-west-1"`), `workspace_id`. Returns `data: Filesystem`.
  Errors: 400 `global/duplicate`, `global/quota-exceeded`, `global/invalid-parameters`; 401; 403 `global/account-inactive`, `global/invalid-address`; 404; 429.
- `DELETE /api/v1/filesystems/{id}` → `data: { deleted_ids: string[] }`. "The filesystem must not be mounted to any running instances": 400 `filesystems/filesystem-in-use`; 404 `global/object-does-not-exist` ("Filesystem was not found.").
- `Filesystem`: `id`, `name`, `mount_point` (default, e.g. `"/lambda/nfs/my-filesystem"`), `workspace_id`, `created` (ISO), `created_by` (`{id, email, status}`), `is_in_use` (bool), `region` (`{name, description}`), `bytes_used` (int, "updated every few hours").
- **Region binding:** a filesystem lives in one region. Launching with a filesystem from another region gives `instance-operations/launch/file-system-in-wrong-region` (400).
- Mounting: default path `/lambda/nfs/<FILESYSTEM_NAME>`, also symlinked into the `ubuntu` user's home [docs]. Custom paths via `file_system_mounts` under `/home`, `/lambda/nfs` or `/data`.
- Limits [docs]: "you can have a total of 24 filesystems"; capacity 8 EB in general; us-south-1 capped at 10 TB.
- Pricing [docs billing]: per GiB **used** per month, billed in one-hour increments, "as long as a filesystem exists, even if it's not mounted". The docs give $0.20/GiB-month only as an example that "might not reflect current pricing"; the actual price is shown when you create one. No ingress or egress fees.

---

## 8. Images [spec + docs]
- `GET /api/v1/images` (`workspace_id` optional): "Retrieves a list of available images by region." → `data: Image[]`.
- `Image` (all required): `id` (e.g. `"43336648-096d-4cba-9aa2-f9bb7727639d"`), `created_time`, `updated_time` (ISO), `name` (e.g. `"ubuntu-24.04.01"`), `description` (e.g. `"Ubuntu LTS"`), `family` (e.g. `"ubuntu-lts"`), `version` (e.g. `"24.04.01"`), `architecture` (`x86_64` | `arm64`), `region` (`{name, description}`).
- Image families from the docs (on-demand overview): `lambda-stack-24-04`, `lambda-stack-22-04`, `lambda-stack-legacy-22-04`, `gpu-base-24-04`, `gpu-base-22-04`, `ubuntu-24-04`, `ubuntu-22-04`.
- Default: launch "Defaults to the latest Lambda Stack image" [spec]. Lambda Stack is "The default image used on most ODC instances" and "By default, each ODC instance runs Ubuntu 22.04 LTS" [docs].
- Launch with `"image": {"family": "..."}` or `"image": {"id": "..."}`. Images are listed per region with an architecture (GH200 is arm64), so check that the chosen family exists for the region and architecture [inference].

---

## 9. Firewall [spec]
- Legacy account-level rules: `GET /api/v1/firewall-rules`; `PUT /api/v1/firewall-rules` with body `{ "data": FirewallRule[] }` (replaces all). "Firewall rules do not apply to the us-south-1 region."
- Rulesets: `GET/POST /api/v1/firewall-rulesets`, `GET/PATCH/DELETE /api/v1/firewall-rulesets/{id}`, `GET/PATCH /api/v1/firewall-rulesets/global`.
  - Create body: `name` (≤ 64, req), `region` (req), `rules` (req), `workspace_id`.
  - PATCH: `name` and/or `rules`. The global ruleset (`id` const `"global"`) only takes `rules` (+ `workspace_id`).
  - Delete while attached: 400 `firewall-rulesets/firewall-ruleset-in-use`; not found: 404 `global/object-does-not-exist`; create/patch/delete can return 409 `global/internal-error`; create can return `global/quota-exceeded`.
- `FirewallRule`: `protocol` (`tcp` | `udp` | `icmp` | `all`, req), `port_range` (`[min, max]`, 1–65535; required except for icmp; one port = `[22, 22]`), `source_network` (CIDR, req, e.g. `"0.0.0.0/0"`), `description` (0–128, req).
- `FirewallRuleset`: `id`, `name`, `region`, `rules`, `workspace_id`, `created`, `instance_ids`.
- Docs defaults: "By default, only port 22 (SSH) is open"; ICMP allowed by default.

---

## 10. Billing and quotas
- On-demand instances "bill in one-minute increments". "Billing begins the moment you launch an instance and the instance passes health checks", and it ends at terminate. Idle time is billed. Invoices are weekly [docs billing]. `first_healthy` on the instance shows when billing effectively starts [inference].
- No stop/pause: only terminate ends billing. Refunds are service credits that expire after 12 months [docs].
- Sales tax/VAT is added based on the billing address [docs].
- **Quotas:** "New accounts have a limit on the number of instances you can launch." The limit "increases automatically as you pay your invoices" [docs creating-managing-instances]. No numbers are published. Hitting it gives `global/quota-exceeded` with suggestion "Contact Support to increase your quota." [spec]. **For an 8× H100 in December, contact Lambda Support now to confirm the account can launch an 8× instance**; a new account with no paid invoices may be blocked even when capacity exists [inference from the docs + spec].
- The account must be active: verified email, valid payment method (403 `global/account-inactive`) and a valid billing address (403 `global/invalid-address`).
- The API has no spend cap or budget endpoint. `GET /api/v1/audit-events` exists for an audit log.

---

## 11. Gotchas for a sniper

1. **Capacity windows are short.** A 2026 hunter's comment: "Capacity windows are seconds wide: a failed launch must NOT kill the hunt (2026-07-21: an HTTP 400 crashed the hunter while australia-east-1 still had 8x B200 stock)" (RightNow-AI/inkling-turbo). Lambda forum staff (2022): "there's no way to know how long you'll have to wait".
2. **Availability is a hint, not a reservation.** `regions_with_capacity_available` can be gone by the time you launch, so expect `insufficient-capacity` even right after a positive poll. Its message may list other regions with capacity. Retry launch only on `insufficient-capacity`, at most 1 per 12 s. Lambda's own support script loops on launch and treats that code as "retry" and everything else as fatal.
3. **Launch is not idempotent.** freesolo-co/flash: "`POST /instance-operations/launch` is NOT idempotent, so it is never retried here (a blind retry can rent and bill a second VM). Callers reconcile an ambiguous launch by listing instances by name instead." On timeout or 5xx, **don't** re-POST blindly. First `GET /instances` and look for your `name`/tag. Keep a lock (Durable Object/KV) so two invocations can't both launch. Real snipers also refuse to run when an instance with their name prefix already exists.
4. **A 200 is not the finish line.** The status goes `booting` → `active`, and the enum also has `unhealthy`, `terminating`, `terminated`, `preempted`. Poll `GET /instances/{id}` (real code: every 15 s, timeout 25 min; docs: "several minutes") until `status=="active"` and `ip` is set. Treat `unhealthy`/`terminated`/`preempted` as a failure: terminate if needed, alert, and resume hunting. Billing starts only after health checks pass.
5. **Polling budget.** 1 rps is the general limit for all calls. Spend it on `GET /instance-types` (one call covers all types and regions) and stay well under it, e.g. every 2–5 s, leaving headroom for the launch and status calls. On 429, honour `Retry-After`. Cloudflare Cron Triggers fire at most once a minute, which is too coarse for second-wide windows, so use a **Durable Object alarm loop** (or an always-on poller) for 2–5 s polling [inference/recommendation].
6. **Region-bound attachments.** Filesystems and firewall rulesets are per-region. With a filesystem attached, a launch can only succeed in that filesystem's region (`file-system-in-wrong-region`). For a multi-region sniper, launch **without** a filesystem, or keep one filesystem per candidate region and pick it by region.
7. **Architecture.** `gpu_1x_gh200` is arm64. An x86 image family would fail.
8. **SSH key:** exactly one, by **name**, and it must exist in the same workspace.
9. **User-Agent:** send an explicit one; Cloudflare in front of the API rejected a default Python UA (real code).
10. **Parse `error.code`, never `message`.** Treat `provider/*` codes and 5xx as transient.
11. **Price check before launch.** Read `price_cents_per_hour` from the same poll response and enforce a maximum in the Worker (8× H100 SXM ≈ $36.72/h, 8× B200 ≈ $61.52/h at today's list prices).

---

## Sources
- Official API reference: https://docs.lambda.com/api/cloud ; OpenAPI spec v1.10.0: https://docs.lambda.com/api/cloud/spec.json
- Billing: https://docs.lambda.com/public-cloud/billing/
- On-demand overview (instance table, regions, images, filesystems): https://docs.lambda.com/public-cloud/on-demand/
- Creating/managing instances (quota text): https://docs.lambda.com/public-cloud/on-demand/creating-managing-instances/
- Pricing: https://lambda.com/pricing
- Older docs (redirect chain): https://docs.lambdalabs.com/public-cloud/cloud-api ; older spec 1.9.3 mirror: https://github.com/jentic/jentic-public-apis/tree/main/apis/openapi/lambdalabs.com/main/1.9.3
- Lambda support script: https://github.com/lambdal-support/lambda-public-tools/blob/main/launch_instance.py
- SkyPilot catalog: https://github.com/skypilot-org/skypilot-catalog/tree/master/catalogs/v8/lambda
- Real snipers: https://github.com/RightNow-AI/inkling-turbo (scripts/grab_b200.py, grab_8x_gates.py), https://github.com/KMKoushik/lambda-gpu-snatcher (src/index.ts), https://github.com/hcltech-robotics/Cosmos-3-NanoH-Surgical-dVRK (scripts/lambda_wait_for_capacity.py), https://github.com/freesolo-co/flash (flash/providers/lambda_/client.py), https://github.com/komira-ai/jobscheduler (crates/js-provider-lambdalabs/src/error.rs)
- Forum: https://deeptalk.lambda.ai/t/how-long-does-it-usually-take-for-gpus-to-become-available/3365
