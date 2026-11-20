# UpCloud API 1.3: watching for GPU capacity and creating GPU servers (research for a Cloudflare Worker)

Research date: 20.11.2026. Base URL: `https://api.upcloud.com/1.3`. Every request is JSON (`Accept: application/json`, `Content-Type: application/json`).

## Where the facts come from

**[SDK]**: the official Go SDK, `UpCloudLtd/upcloud-go-api`, cloned at v8.42.0 plus the Unreleased section. Files used: `upcloud/*.go`, `upcloud/request/*.go`, `upcloud/service/*.go`, and the recorded real API calls in `upcloud/service/fixtures/*.yaml`.

**[CLI]**: `UpCloudLtd/upcloud-cli` (v3). Files: `internal/commands/zone/devices/*.go` and `CHANGELOG.md`.

**[TF]**: `UpCloudLtd/terraform-provider-upcloud`. File: `internal/service/server/server.go`.

**[DOCS]**: the legacy API docs, read with WebFetch. They are still published and match the SDK:
- https://developers.upcloud.com/1.3/8-servers/
- …/3-accounts/
- …/24-api-tokens/
- …/2-architecture/
- …/4-pricing/
- …/5-zones/
- …/7-plans/
- …/9-storages/
- …/25-file-storage/

**[PROD]**: product documentation pages.
- https://upcloud.com/docs/products/gpu-servers/ with the sub-pages `configurations/`, `availability/`, `faq/`, `spot/`, `managing/`, `software/` and `storage/`
- https://upcloud.com/docs/products/file-storage/availability/
- https://upcloud.com/pricing/

**[CL]**: the changelog at https://upcloud.com/docs/changelog/. Entries used: 2025-07-04, 2026-05-18, 2026-06-08, 2026-07-06, 2026-08-18 and 2026-10-15.

**Sources I could not read**, so nothing below relies on them:
- The raw OpenAPI spec, `https://developers.upcloud.com/api/1.3/upcloud-openapi.json` (its URL is given in the 2026-06-08 changelog entry). WebFetch failed because a permission request timed out. The sandbox egress proxy also blocks `developers.upcloud.com` and `upcloudltd.github.io` for curl.
- `github.com/UpCloudLtd/upcloud-openapi-spec`. raw.githubusercontent.com returns 404, so the repository is probably private or has another name.
- The new portal at `upcloudltd.github.io/upcloud-openapi-spec/api` is rendered by JavaScript. WebFetch saw only section names and short descriptions.

**Recommended next step:** download `upcloud-openapi.json` once from a normal machine and grep it for `gpu`, `availability`, `spot` and `429`. That confirms the items marked **UNVERIFIED** below.

Labels used below: **VERIFIED** means the fact is quoted from a source above. **UNVERIFIED** means it is a reasoned inference that needs a test on the live account.

---

## 1. Authentication

### Bearer API tokens (recommended)
- [DOCS 2-architecture / new portal Getting Started]: "The UpCloud API uses HTTP Bearer authentication."
- Header: `Authorization: Bearer ucat_01DQE3AJDEBFEKECFM558TGH2F`. Tokens start with `ucat_` [DOCS 24-api-tokens].
- The SDK sends `"Bearer "+token` [SDK client/client.go]. The env vars are `UPCLOUD_TOKEN`, or `UPCLOUD_USERNAME` with `UPCLOUD_PASSWORD`. The SDK refuses to use both methods at once.
- Tokens can be created in the control panel (Hub), with `upctl`, or through the API.

**Create a token: `POST /1.3/account/tokens`** [DOCS 24-api-tokens; SDK request/token.go]

| field | accepted values | required | notes |
|---|---|---|---|
| `name` | 1–1024 characters | yes | |
| `expires_at` | RFC 3339 timestamp | yes | Must be in the future and at most 8760 h (365 days) away. |
| `can_create_tokens` | true/false | no | Default false. |
| `allowed_ip_ranges` | array of 0–100 CIDR or IP addresses | no | Default is the account IP filters. If the account has none, the default is `["0.0.0.0/0"]`. **An empty list `[]` denies access from everywhere.** |

```json
POST /1.3/account/tokens
{ "name": "gpu-sniper-worker", "expires_at": "2027-11-19T00:00:00Z",
  "can_create_tokens": false, "allowed_ip_ranges": ["0.0.0.0/0"] }
```

- The response is `201 Created`. Fields: `token` (the bearer token, **returned only at creation**), `id`, `name`, `type`, `created_at`, `expires_at`, `can_create_tokens`, `allowed_ip_ranges`, `gui`.
- The SDK also has `last_used_at`, and `type` takes `pat` or `workspace` [SDK token.go].
- Other token endpoints:
  - `GET /1.3/account/tokens?limit=1..100&offset=…&sort=±created_at|expires_at|last_used_at|name` returns 200.
  - `GET /1.3/account/tokens/{id}` returns 200.
  - `DELETE /1.3/account/tokens/{id}` returns 204.
- Errors: 400 validation; 401 "Authentication failed."; 403 "the token used to authenticate is not allowed to create tokens"; 404 "Token not found."

**Notes for a Cloudflare Worker:**
- Workers do not have fixed egress IPs, so `allowed_ip_ranges` must stay wide (`0.0.0.0/0`).
- **UNVERIFIED:** Workers may connect over IPv6. The docs show only an IPv4 example. If a token restricted to `0.0.0.0/0` gets 401 from a Worker, add `::/0`.
- Tokens expire after at most one year. Store `expires_at` and raise an alert before it passes.

### HTTP Basic with a subaccount
- [DOCS 2-architecture]: Basic auth "can also be used". "Use of this authentication method is discouraged, and it will be deprecated and disabled at a later date." UpCloud recommends "an API subaccount with HTTP Basic authentication", created on the People page.
- Subaccount fields [DOCS 3-accounts]:
  - `allow_api` (`yes`/`no`) controls Basic API use. It "has no effect on API tokens, API access is implicitly allowed when using API tokens".
  - `ip_filters: {"ip_filter": [...]}` restricts API access by IP range.
- A failed login returns 401 with `AUTHENTICATION_FAILED`.

**Recommendation for automation:** use a Bearer token. Basic auth is announced for deprecation.

### Cheap token check: `GET /1.3/account`
[DOCS 3-accounts; SDK account.go and account_test.go]

```json
{ "account": {
    "credits": 9972.2324,
    "username": "username",
    "resource_limits": {
      "cores": 200, "detached_floating_ips": 10, "managed_object_storages": 7,
      "memory": 1048576, "network_peerings": 100, "networks": 100,
      "ntp_excess_gib": 20000, "public_ipv4": 100, "public_ipv6": 100,
      "storage_hdd": 10240, "storage_maxiops": 10240, "storage_ssd": 10240,
      "load_balancers": 50, "gpus": 8 } } }
```

- A 200 response means the token works. 401 means it is invalid.
- `credits`: "Credits are automatically deducted for used resources on an hourly basis." Active resources are disabled if the balance goes negative.
- `resource_limits` units [DOCS]:
  - `memory`, `storage_*`: MiB.
  - `cores`: count.
  - `gpus`: GPU count. The SDK field `GPUs int json:"gpus"` was added in SDK 8.23 ("account: add GPUs to resource limits"). The legacy docs page does not list `gpus` yet.
- The legacy docs example also contains `storage_standard`, `storage_total`, `managed_databases`, `managed_kubernetes`, `network_gateways` and `routers`.
- The `gpus: 8` and `memory: 1048576` values above come from an SDK test fixture. They are not defaults for your account.

---

## 2. Plans, zones, prices, capacity and limits

### `GET /1.3/plan`
[DOCS 7-plans; SDK plan.go]

```json
{ "plans": { "plan": [
  { "core_number": 1, "memory_amount": 2048, "name": "1xCPU-2GB",
    "public_traffic_out": 2048, "storage_size": 50, "storage_tier": "maxiops" },
  { "core_number": 32, "memory_amount": 393216, "name": "GPU-32xCPU-384GB-2xL40S",
    "public_traffic_out": 44, "storage_size": 0, "storage_tier": null,
    "gpu_amount": 2, "gpu_model": "NVIDIA L40S" } ] } }
```

Plan object fields [SDK]: `core_number`, `memory_amount` (MiB), `name`, `public_traffic_out`, `storage_size`, `storage_tier`, `gpu_amount`, `gpu_model`.

- New portal: "GPU plans also have additional gpu_amount and gpu_model attributes."
- "All plans are available in all zones but pricing may differ."
- **GPU plans include no storage** (`storage_size: 0`, `storage_tier: null`). Every create request must give a storage size and tier explicitly.

**Current GPU plans** [PROD configurations]. "GB" in the names means GiB. NVLink is present on H100, B200 and B300.

| GPU | Plans (GPUs / vCPU / RAM GiB) | CPU |
|---|---|---|
| L4 | `GPU-8xCPU-64GB-1xL4` (1/8/64), `GPU-12xCPU-128GB-1xL4`, `GPU-12xCPU-128GB-2xL4`, `GPU-16xCPU-192GB-1xL4`, `-2xL4`, `-3xL4`, `GPU-20xCPU-256GB-1xL4`, `-2xL4`, `-3xL4`, `GPU-32xCPU-384GB-2xL4`, `-3xL4` | AMD EPYC 9575F |
| L40S | the same 11 shapes with the suffix `xL40S`, e.g. `GPU-8xCPU-64GB-1xL40S` | AMD EPYC 9575F |
| RTX Pro 6000 | `GPU-16xCPU-80GB-1xRTXPRO6000`, `GPU-32xCPU-160GB-2xRTXPRO6000`, `GPU-64xCPU-320GB-4xRTXPRO6000`, `GPU-128xCPU-640GB-8xRTXPRO6000` | AMD EPYC 9555 |
| **H100** | `GPU-12xCPU-240GB-1xH100` (1/12/240), `GPU-24xCPU-480GB-2xH100` (2/24/480), `GPU-48xCPU-960GB-4xH100` (4/48/960), **`GPU-96xCPU-1920GB-8xH100` (8/96/1920)** | Intel Xeon Platinum 8462Y+ |
| B200 | `GPU-24xCPU-240GB-1xB200`, `GPU-48xCPU-480GB-2xB200`, `GPU-96xCPU-960GB-4xB200`, `GPU-192xCPU-1920GB-8xB200` | Xeon Platinum 8570 / Xeon 6767P / EPYC 9575F |
| B300 | `GPU-28xCPU-240GB-1xB300`, `GPU-56xCPU-480GB-2xB300`, `GPU-112xCPU-960GB-4xB300`, `GPU-224xCPU-1920GB-8xB300` | Intel Xeon 6768P |

Spot variants put `SPOT` after `GPU`, for example `GPU-SPOT-8xCPU-64GB-1xL40S` [PROD configurations]. See section 10.

### `GET /1.3/zone`
[DOCS 5-zones; SDK zone.go]

```json
{ "zones": { "zone": [ { "id": "fi-hel2", "description": "Helsinki #2", "public": "yes" } ] } }
```

- Zone fields: `id`, `description`, `public`, `parent_zone` (private cloud only).
- The SDK's Unreleased section adds `trial_allowed`.
- **GPU zones:** the GPU Availability page [PROD availability] lists only `fi-hel2` (Helsinki).
- The live per-zone list comes from `/device/availability`, described below.

### Prices: `GET /1.3/price`
There is no `/price/zone` endpoint in the docs or the SDK. The SDK's `GetPriceZones` and `GetPricesByZone` both call `/price`.

```json
{ "prices": { "zone": [ { "name": "fi-hel1",
    "server_plan_1xCPU-2GB": { "amount": 1, "price": 2.2321 },
    "storage_maxiops": { "amount": 1, "price": ... }, ... } ] } }
```

- Each zone object maps item name to `{amount, price}` [SDK price.go `PricesByZone`].
- Currency: "in the currency used by the account that sent the request". The account currency is in `GET /1.3/account/details` → `currency`.
- Billing is hourly according to this price list.
- **UNVERIFIED:** the unit appears to be cents per hour, but the docs never state it. Check by reading `server_plan_GPU-96xCPU-1920GB-8xH100` in fi-hel2. Expect about `1736` if the unit is cents and the account currency is EUR.

**Public price list** [PROD pricing], EUR/hour, on-demand / spot:

| Plan | On-demand | Spot |
|---|---|---|
| 1×H100 | 2.17 | 1.79 |
| 2×H100 | 4.34 | 3.58 |
| 4×H100 | 8.68 | 7.16 |
| **8×H100** | **17.36** | **14.32** |
| 8×B200 | 42.08 | 29.46 |
| 8×B300 | 55.60 | 41.70 |
| 8×RTX PRO 6000 | 13.20 | 6.96 |
| 1×L40S, 8 vCPU | 1.11 | 0.83 |
| 1×L4, 8 vCPU | 0.58 | 0.57 |

- "GPU Server plans are billed by the starting hour." Prices exclude local taxes.

### Capacity and availability endpoint: `GET /1.3/device/availability` (VERIFIED in SDK, CLI and TF)
This is the key finding.

- SDK `service/cloud.go`: `GetDevicesAvailability(ctx)` calls `s.get(ctx, "/device/availability", &r)`.
- SDK changelog 8.21.0: "`GetDevicesAvailability` function for listing device availability per zone."
- CLI 3.21.0 (2025-07-15) added `upctl zone devices` ("List available devices for each zone") and `upctl zone devices show fi-hel2` ("Show detailed device availability for the given zone").
- The Terraform provider says: "To deploy a GPU server, select a plan with `GPU-` prefix… Use `upctl zone devices` command to list per zone GPU availability."

Response shape [SDK device.go and device_test.go, verbatim]:

```json
{ "fi-hel2": { "gpu_plans": { "GPU-8xCPU-64GB-1xL40S": { "amount": 123 } } } }
```

- Go types: `DevicesAvailability map[zone]Devices`, `Devices{ GPUPlans map[planName]DeviceAvailability json:"gpu_plans" }`, `DeviceAvailability{ Amount int json:"amount" }`.
- The CLI prints the plan name and an "Amount" column. When a zone has a non-empty `gpu_plans`, the zone gets the "GPU" feature.

**UNVERIFIED (no doc text found):**
- What `amount` exactly means. The likeliest reading is how many servers of that plan can be started now. It could also be a GPU count.
- Whether plans with no capacity are listed with `amount: 0` or left out.
- Whether `GPU-SPOT-*` plans appear.
- Whether the number already reflects your account's GPU quota.

**Treat it like this:** the plan key is missing or `amount < 1` means no capacity. `amount >= 1` means try to create now. Log the raw JSON from the live account on the first runs to settle what `amount` means. The call needs authentication (it goes through the normal authenticated `get`).

### Other GPU endpoints
- `GET /1.3/server/{uuid}/gpus` [DOCS 8-servers] returns `{"gpus":[{"cores":18176,"firmware":"95.02.66.00.15","memory_gib":48,"model":"NVIDIA L40S","part":"900-2G133-0180-030","serial":"1723925007011"}, …]}`. Error: 400 `SERVER_INVALID`. (The docs print the status line as "200 No Content".)
- Server details contain `devices: {device: [{model, type: "gpu", serial, metadata: {serial, cores, memory}}]}` [DOCS; SDK `Device`, `DeviceMetadata`].

### Account GPU limits
- The field is `GET /1.3/account` → `account.resource_limits.gpus` [SDK]. The CLI changelog says: "Expose GPU limits in `account show` command".
- [PROD availability]:
  - "Each account has access to a limited number of GPUs, based on its account history."
  - "Contact support if you need access to more GPUs than are currently available to your account."
  - "Promotional credits cannot be used to deploy GPU Servers."
  - "To access on-demand GPU Servers, you must make a payment of at least 50% of the value of your promotional credits."
  - GPU Servers are not available in the free trial [PROD configurations].
- **Checks before the competition, for the 8×H100 plan:**
  - `resource_limits.gpus` must be ≥ 8.
  - **UNVERIFIED:** GPU plans probably also count against `cores` (needs ≥ 96 plus your other servers) and `memory` (needs ≥ 1,966,080 MiB = 1920 GiB plus your other servers). The SDK fixture value `memory: 1048576` is only 1 TiB. If your limit is that low, creation fails with 403 `SERVER_MEMORY_LIMIT_REACHED`.
  - Raise all three limits with support in advance.
- **No error code specific to GPUs was found** in the docs' create, start or modify tables or in SDK `error_codes.go`. There is no `GPU_*` code, no `PLAN_UNAVAILABLE` and no `RESOURCE_LIMIT_*`. Exceeding the GPU quota will likely return 403 with some `*_LIMIT_REACHED` code (UNVERIFIED). Treat any 403 `*_LIMIT_REACHED` as fatal: alert and stop retrying.

---

## 3. `POST /1.3/server`: create a server from a template

[DOCS 8-servers; SDK request/server.go `CreateServerRequest`; real recorded call in SDK fixture `createdeleteserverandstorage.yaml`]

The whole body is wrapped in `{"server": {...}}`. Booleans are the strings `"yes"`/`"no"`. Lists use wrapper objects: `labels.label[]`, `storage_devices.storage_device[]`, `networking.interfaces.interface[]`, `ip_addresses.ip_address[]` and `login_user.ssh_keys.ssh_key[]`.

```json
POST /1.3/server
{ "server": {
  "zone": "fi-hel2",
  "title": "gpu-comp-8xh100",
  "hostname": "gpu-comp-1.example.com",
  "plan": "GPU-96xCPU-1920GB-8xH100",
  "metadata": "yes",
  "user_data": "#cloud-config\n...",
  "login_user": { "username": "ubuntu",
                  "create_password": "no",
                  "ssh_keys": { "ssh_key": ["ssh-ed25519 AAAA... user@host"] } },
  "storage_devices": { "storage_device": [
     { "action": "clone", "storage": "<TEMPLATE_UUID>", "title": "os",
       "size": 500, "tier": "maxiops", "encrypted": "no" } ] },
  "networking": { "interfaces": { "interface": [
     { "type": "public",  "ip_addresses": { "ip_address": [ { "family": "IPv4" } ] } },
     { "type": "utility", "ip_addresses": { "ip_address": [ { "family": "IPv4" } ] } } ] } },
  "labels": { "label": [ { "key": "managedBy", "value": "gpu-sniper" },
                         { "key": "attempt", "value": "2026-12-01T10:00Z" } ] },
  "firewall": "off",
  "simple_backup": "no",
  "password_delivery": "none",
  "remote_access_enabled": "no"
} }
```

### Fields [DOCS table + SDK tags]
- `zone` (required), `title` (required, 1–255), `hostname` (required, **lower case**; otherwise `HOSTNAME_INVALID`).
- `plan`: a plan name, or `custom` (the default). If `core_number` or `memory_amount` are present they must match the plan. Otherwise you get 403 `PLAN_CORE_NUMBER_ILLEGAL` / `PLAN_MEMORY_AMOUNT_ILLEGAL`.
- `metadata`: `yes`/`no`, default `no`. **Must be `"yes"` with cloud-init templates.** Otherwise you get 409 `METADATA_DISABLED_ON_CLOUD-INIT` ("Metadata cannot be disabled when creating a server from a cloud-init template.").
- `user_data`: "a valid URL or shell script". It defines the URL of a server setup script, or the script body itself.
- `login_user`:
  - `username` defaults to `root`. Any other value creates a normal user with sudo.
  - `create_password` is `yes`/`no`. It defaults to `no` when `ssh_keys` is set.
  - `ssh_keys.ssh_key[]` holds 1–32 keys.
  - "ssh_keys are also the only login method for cloud-init enabled templates". Asking for a password there gives 409 `CAN_NOT_CREATE_PASSWORD_FOR_THE_SELECTED_DISTRIBUTION`. A reserved username gives 409 `INVALID_USERNAME`.
- `storage_devices.storage_device[]` holds 1–16 entries (the error table text says "more than four" gives `STORAGE_DEVICE_LIMIT_REACHED`).
  - `action`: `create` | `clone` | `attach` (required).
  - `storage`: required for clone and attach (template or storage UUID).
  - `title`.
  - `size` in GB:
    - The servers page gives 10–1024. The storage page gives 1–4096. The GPU configurations page says "1 GiB to 4 TiB".
    - These sources disagree. Stay within 1024 in the create call, or resize later.
  - `tier`: `maxiops` | `standard` | `hdd`. It defaults to the plan default, else `maxiops`. GPU plans have `storage_tier: null`, so set `maxiops` explicitly.
  - `encrypted`: `yes`/`no`.
  - `type`: `disk`/`cdrom`.
  - `address`: `virtio` | `scsi` | `ide` with an optional index.
  - `backup_rule`.
  - Only one template per request; otherwise `MULTIPLE_TEMPLATES`.
- `networking.interfaces.interface[]` holds 1–10 interfaces.
  - `type`: `public` | `utility` | `private`.
  - `network` is required for `private`.
  - `ip_addresses.ip_address[]` entries have a `family` of `IPv4` or `IPv6` (IPv6 only on public interfaces).
  - Optional: `index`, `bootable`, `source_ip_filtering`.
- `labels.label[]` holds 0–255 key/value pairs. Use them to tag and clean up attempts.
- `simple_backup`: `HHMM,daily|dailies|weeklies|monthlies`, or `no`.
- `firewall`: `on`/`off`, default `on`. The firewall is billed separately (the price list has a `firewall` item).
- `server_group`: a server group UUID.
- Also accepted: `timezone`, `nic_model`, `video_model`, `boot_order`, `password_delivery` (`none`/`email`/`sms`), `remote_access_enabled`/`_type`/`_password`, `host`/`avoid_host` (private cloud), `core_number`, `memory_amount`.

### Response and lifecycle
- **`202 Accepted`**. Creation is asynchronous [DOCS; SDK fixture `code: 202`].
- The body is the full server details: `{"server": {"uuid": "...", "state": "maintenance", "progress": "0", "plan": "...", "ip_addresses": {...}, "storage_devices": {...}, "password": "...", ...}}`.
- "Servers are started automatically after creation". Poll `GET /1.3/server/{uuid}` until `state == "started"`. The SDK's `WaitForServerState` polls the same way.
- Server states [DOCS + SDK constants]:
  - `started`, `stopped`: the normal states.
  - `maintenance`: temporary, while the cloud updates the server, including during creation.
  - `error`: "The server has encountered an error." The server is inaccessible until resolved, then returns to `started` or `stopped`.

---

## 4. Templates: `GET /1.3/storage/template`

[DOCS 9-storages; SDK storage.go and request/storage.go]

The SDK builds the URL as `/storage[/{access}][/{type}][/favorite]`. Useful lists: `/storage/template`, `/storage/private`, `/storage/public`, plus `?label=key=value`.

```json
{ "storages": { "storage": [
  { "access": "public", "encrypted": "no", "labels": [], "license": 0, "size": 5,
    "state": "online", "template_type": "cloud-init",
    "title": "Ubuntu Server 24.04 LTS (Noble Numbat)", "type": "template",
    "uuid": "01000000-0000-4000-8000-000030240200" } ] } }
```

- `template_type` is `cloud-init` or `native` [SDK constants]. Storage `state` is one of `online`, `maintenance`, `cloning`, `backuping`, `error`, `syncing`.
- **Ubuntu 24.04:** title `"Ubuntu Server 24.04 LTS (Noble Numbat)"`, UUID `01000000-0000-4000-8000-000030240200`. Sources: the SDK test fixture and the CLI default `--os`. The CLI says that template "only supports SSH key based authentication".
- **AI/ML GPU template:** the docs name it "AI/ML-ready GPU Ubuntu template" and recommend it. It includes NVIDIA drivers, common GPU libraries, Docker and the NVIDIA Container Toolkit [PROD faq, software, managing].
  - **No UUID or exact title is published anywhere.**
  - Find it at runtime: `GET /1.3/storage/template`, then filter on `title` containing `GPU` (or `AI`/`ML`), case-insensitive. Store the UUID and verify it once by hand.
- **Template requirements for GPU servers:** "Any supported public template works, including Linux and Windows Server" [PROD faq]. Without the AI/ML template you install the NVIDIA drivers and CUDA yourself. The AI/ML and Ubuntu 24.04 templates are cloud-init, so `metadata:"yes"` and `ssh_keys` are required.
- Look templates up dynamically, because UUIDs of public templates can change when UpCloud rebuilds them.

---

## 5. Error responses

### Formats
[DOCS 2-architecture; SDK service.go `parseJSONServiceError`, client.go, problem.go]

1. **Legacy format, used by the server, storage and account endpoints.** `Content-Type: application/json`.
   ```json
   { "error": { "error_code": "SERVER_RESOURCES_UNAVAILABLE",
                "error_message": "There are not enough server resources available in the specified zone to create the requested server." } }
   ```
   Recorded example [SDK errorhandling.yaml]: HTTP 400, `{"error":{"error_code":"SERVER_INVALID","error_message":"The server UUID is invalid."}}`.
2. **RFC 7807 format, used by newer endpoints** (file storage, managed services). `Content-Type: application/problem+json`.
   ```json
   { "type": "https://.../#ERROR_XYZ", "title": "...", "status": 409,
     "correlation_id": "...", "invalid_params": [ { "name": "...", "reason": "..." } ] }
   ```
   The SDK derives the code as the URL fragment of `type` with the `ERROR_` prefix removed, or uses `type` itself if it is not a URL.

**The Worker should:** branch on the Content-Type, normalise both formats to `{status, code, message}`, and log the raw body.

### HTTP statuses [DOCS 2-architecture]
| Status | Meaning |
|---|---|
| 200 | OK |
| 201 | Created (tokens) |
| 202 | Accepted, asynchronous (create or modify server) |
| 204 | No Content (delete) |
| 400 | Invalid, unknown or missing attributes |
| 401 | Authentication failed |
| 402 | Insufficient credits |
| 403 | Forbidden or quota reached |
| 404 | Not found |
| 409 | "conflict between resources" |
| 500 | Temporary problem in the cloud service |
| 503 | Maintenance |

429 is not documented anywhere.

### Create-server codes relevant to capacity, limits and money
Verbatim from the [DOCS 8-servers] Create server table. All of them also exist as SDK constants unless marked "docs only".

| HTTP | error_code | Description (verbatim) | Worker action |
|---|---|---|---|
| **409** | **`SERVER_RESOURCES_UNAVAILABLE`** | "There are not enough server resources available in the specified zone to create the requested server." | **This is the "no GPU capacity" signal. Retry later.** |
| 409 | `STORAGE_RESOURCES_UNAVAILABLE` | "There are not enough storage resources available in the specified zone to create the requested storages." | Retry later |
| 409 | `IP_ADDRESS_RESOURCES_UNAVAILABLE` | "There were not enough IP addresses available in the specified zone to create the requested server." | Retry later |
| 409 | `SERVER_CREATING_LIMIT_REACHED` | "There are too many servers simultaneously being created." | Back off and retry |
| 409 | `SERVER_RESOURCES_UNAVAILABLE_FOR_STRICT_AA` (docs only) | "Conditions for strict anti-affinity policy cannot currently be met…" | Only if using a server group |
| 402 | `INSUFFICIENT_CREDITS` | "There are not enough credits to perform the requested action." | Fatal. Alert. |
| 403 | `SERVER_CORE_LIMIT_REACHED` | "Server core account quota limit reached." | Fatal. Alert. |
| 403 | `SERVER_MEMORY_LIMIT_REACHED` | "Server memory account quota limit reached." | Fatal. Alert. |
| 403 | `MAXIOPS_STORAGE_LIMIT_REACHED` / `STANDARD_STORAGE_LIMIT_REACHED` (docs only) / `HDD_STORAGE_LIMIT_REACHED` (docs only) | "… storage account quota limit reached." | Fatal |
| 403 | `SERVER_IP_LIMIT_REACHED` | "Server IP account quota limit reached." | Fatal |
| 403 | `NETWORK_LIMIT_REACHED`, `DETACHED_FLOATING_IP_LIMIT_REACHED`, `NETWORK_PEERING_LIMIT_REACHED` (docs only) | quota | Fatal |
| 403 | `PLAN_CORE_NUMBER_ILLEGAL` / `PLAN_MEMORY_AMOUNT_ILLEGAL` | core_number or memory_amount does not match the plan | Bug. Fix the payload. |
| 403 | `HOST_FORBIDDEN`, `STORAGE_FORBIDDEN` | | Bug |
| 409 | `METADATA_DISABLED_ON_CLOUD-INIT` | "Metadata cannot be disabled when creating a server from a cloud-init template." | Bug: set `metadata:"yes"` |
| 409 | `CAN_NOT_CREATE_PASSWORD_FOR_THE_SELECTED_DISTRIBUTION` | "…Please, use SSH keys instead." | Bug |
| 409 | `INVALID_USERNAME`, `MULTIPLE_TEMPLATES`, `STORAGE_DEVICE_LIMIT_REACHED`, `STORAGE_TIER_ILLEGAL`, `ZONE_MISMATCH`, `TOO_MANY_BOOT_DISKS`, `LABEL_LIMIT_REACHED`, `BACKUP_RULE_CONFLICT`, `WINDOWS_NOT_AVAILABLE` ("…in trial mode"), `MS_LMA_REQUIRED` | | Bug or config |
| 409 | `TRIAL_PLAN` (SDK constant only, no description) | probably "plan not allowed in trial" | Fatal |
| 400 | `HOSTNAME_INVALID`, `ZONE_INVALID`, `REQUEST_INVALID`, `UNKNOWN_ATTRIBUTE`, `VALIDATION_ERROR`, … | | Bug |
| 404 | `ZONE_NOT_FOUND`, `STORAGE_NOT_FOUND` | | Bug |
| 500 / 503 | `SERVICE_ERROR` / maintenance | | Retry with backoff. The SDK retries up to 3 times on ≥500. |

**Codes that do not exist** in the docs or SDK: `SERVER_CREATION_FAILED`, `PLAN_UNAVAILABLE`, `RESOURCE_LIMIT_*`, any `GPU_*` code. Do not match on them.

**Start-server errors** [DOCS]: 400 `SERVER_INVALID`; 404 `SERVER_NOT_FOUND` / `HOST_NOT_FOUND`; 402 `INSUFFICIENT_CREDITS`; 403 `SERVER_FORBIDDEN` plus the same quota codes; 409 `NO_STORAGES_ATTACHED`, **`SERVER_RESOURCES_UNAVAILABLE`**, `SERVER_STATE_ILLEGAL`.

---

## 6. Storage

### Block storage
[DOCS 9-storages; SDK]
- `POST /1.3/storage`:
  ```json
  {"storage": {"size": 1000, "tier": "maxiops", "title": "data", "zone": "fi-hel2",
               "encrypted": "no", "labels": [...], "backup_rule": {...}}}
  ```
  - `size` 1–4096 GB. `tier` is `maxiops` | `standard` | `hdd`; the docs default is `hdd`, so set it explicitly.
  - Errors: 402, 403 quota, 404 `ZONE_NOT_FOUND`, 409 `STORAGE_RESOURCES_UNAVAILABLE`.
- Attach: `POST /1.3/server/{uuid}/storage/attach`.
  ```json
  {"storage_device": {"type": "disk", "address": "virtio", "storage": "<uuid>", "boot_disk": "0"}}
  ```
  "SCSI and virtio devices may also be attached while the server state is started."
- Detach: `POST /1.3/server/{uuid}/storage/detach`.
- Resize: `PUT /1.3/storage/{uuid}` with a bigger `size` (it can only grow; you must grow the filesystem yourself). Online resize: `/storage/{uuid}/resize`.
- Delete: `DELETE /1.3/storage/{uuid}?backups=keep|keep_latest|delete`.
- Storage is persistent and can move between servers in the same zone [PROD gpu-servers/storage].
- Prices [PROD pricing], EUR per GB per month: MaxIOPS 0.220, Standard 0.085, Archive 0.056 (0.100 in Helsinki). Billed hourly by allocated size.

### File Storage (managed NFS)
[DOCS 25-file-storage; SDK file_storage.go; PROD file-storage]
- Endpoints:
  - `POST /1.3/file-storage`, `GET /1.3/file-storage`.
  - `GET|PUT|PATCH|DELETE /1.3/file-storage/{uuid}`.
  - `/file-storage/{uuid}/current-state`.
  - `/file-storage/{uuid}/networks[/{name}]`.
  - `/file-storage/{uuid}/shares[/{name}[/acl]]`.
  - These endpoints use RFC 7807 errors.
- Create request:
  ```json
  { "name": "test-name", "zone": "fi-hel2", "configured_status": "started",
    "size_gib": 250, "encrypted": false,
    "networks": [ { "uuid": "<private-net-uuid>", "name": "net", "family": "IPv4", "ip_address": "192.168.147.120" } ],
    "shares": [ { "name": "data", "path": "/data",
                  "acl": [ { "name": "write", "target": "192.168.147.0/24", "permission": "rw" } ] } ],
    "labels": [ { "key": "environment", "value": "production" } ] }
  ```
  - `name`: 1–64 characters matching `^[a-zA-Z0-9_-]+$`.
  - `size_gib`: 250–25000. It can grow but not shrink.
  - `networks`: 0–1 entries. "Private networks must reside in file storage zone." IPv6 is not supported.
  - `shares`: 1–255, each with 0–50 ACL entries. `permission` is `ro` or `rw`.
- **It attaches through an SDN private network.** Servers reach it "over SDN Private Networks". The GPU server needs a `private` interface on the same network.
- Zones [PROD file-storage/availability]: `de-fra1`, `dk-cph1`, `fi-hel1`, **`fi-hel2`**, `nl-ams1`, `se-sto1`, `us-nyc1`.
- Price [PROD pricing]: "from 37.50/month for 250 GB, plus 0.15 per GiB" (EUR).

---

## 7. GPU plan reconfiguration (changelog 18.08.2026)

[CL 2026-08-18; PROD managing, faq, configurations]
- "GPU Servers now support GPU model and plan reconfiguration without reinstalling the server."
- Flow: stop the server, choose another GPU model or plan, start it. The changelog names one use: switching "when your preferred GPU capacity is temporarily unavailable". "You can change the GPU model or plan only while the server is stopped."

API steps [DOCS 8-servers; SDK]:
1. `POST /1.3/server/{uuid}/stop` with `{"stop_server": {"stop_type": "soft", "timeout": "60"}}`, then poll until `state == "stopped"`.
2. `PUT /1.3/server/{uuid}` with `{"server": {"plan": "GPU-96xCPU-1920GB-8xH100"}}`. The response is `202 Accepted`.
   - Modify errors: 403 `PLAN_CORE_NUMBER_ILLEGAL`, `PLAN_MEMORY_AMOUNT_ILLEGAL`, quota codes; 409 `SERVER_STATE_ILLEGAL`, `HOT_RESIZE_NOT_ENABLED`, `HOT_RESIZE_UNAVAILABLE`, `NO_AVAILABLE_MEMORY_SLOTS`.
3. `POST /1.3/server/{uuid}/start` with an optional body `{"server": {"start_type": "sync"|"async", "avoid_host": <id>, "host": <id>}}`.
   - The default `start_type` is `sync`, which returns `200 OK`. With `async` "you need to poll separately".
   - The server must be `stopped`.
   - **When GPUs are not available, start fails with 409 `SERVER_RESOURCES_UNAVAILABLE`.** That code is in the start-server error table. The table is not specific to GPUs, but it is the documented capacity code for start (VERIFIED as a table entry; UNVERIFIED that GPU shortage maps to exactly this code).

**Billing:**
- "Plans are billed only while powered on. Attached block storage and public IPv4 addresses are billed even when the server is stopped" [PROD configurations; FAQ: "until they are deleted or released"].
- "GPU Server plans are billed by the starting hour" [PROD pricing]: every start begins a new billed hour.
- Additional public IPv4: 3.47 EUR/month.

**UNVERIFIED:** whether a **non-GPU** plan (e.g. `1xCPU-2GB` or `custom`) can be switched to a GPU plan. The docs only describe moves from GPU to GPU. Test it with a cheap server before relying on it. The safe version: deploy a 1×L4 server (`GPU-8xCPU-64GB-1xL4`, 0.58 EUR/h) with the AI/ML template, set it up, stop it, then switch it to the 8×H100 plan.

---

## 8. Server lifecycle endpoints

[DOCS 8-servers; SDK request/server.go]

| Action | Request | Result |
|---|---|---|
| List servers | `GET /1.3/server`, with label filter `GET /1.3/server/?label=managedBy=gpu-sniper` (SDK format `label=key=value`; several filters must all match) | `{"servers":{"server":[{uuid,title,hostname,plan,state,zone,core_number,memory_amount,tags,progress,license}]}}` |
| Server details | `GET /1.3/server/{uuid}` | `{"server":{...,"state","plan","devices","ip_addresses","storage_devices","networking","labels"}}` |
| Stop | `POST /1.3/server/{uuid}/stop` with `{"stop_server":{"stop_type":"soft"\|"hard","timeout":"1..600"}}` (default `soft`) | Errors: 400 `STOP_TYPE_INVALID`/`TIMEOUT_INVALID`, 403, 404, 409 `SERVER_STATE_ILLEGAL` |
| Start | `POST /1.3/server/{uuid}/start` | See section 7 |
| Restart | `POST /1.3/server/{uuid}/restart` with `{"restart_server":{"stop_type","timeout","timeout_action":"destroy"\|"ignore"}}` | |
| Delete server only | `DELETE /1.3/server/{uuid}` | Storages stay and keep billing |
| Delete with storages | `DELETE /1.3/server/{uuid}?storages=1&backups=delete` (SDK: `/server/{uuid}/?storages=1&backups=…`) | `204 No Content`. `storages` is 0/1/true/false, default 0. `backups` is `keep`, `keep_latest` or `delete`, default `keep`. **The server must be stopped**, otherwise 409 `SERVER_STATE_ILLEGAL`. Other errors: 400 `STORAGE_DELETION_POLICY_INVALID` / `BACKUP_DELETION_POLICY_INVALID`, 409 `STORAGE_STATE_ILLEGAL`. |

Tear-down sequence: stop with `hard` → poll until `stopped` → `DELETE ?storages=1&backups=delete`. A deleted server also releases its public IPs (UNVERIFIED for floating IPs).

---

## 9. API rate limits

- **Not documented.** The legacy docs, the new portal's Getting Started page and the changelog contain nothing about rate limits.
- The Go SDK and CLI have no 429 or `Retry-After` handling. They retry only on ≥500, at most 3 times, with a 5 s interval.
- The only documented throttle is 409 `SERVER_CREATING_LIMIT_REACHED`: "too many servers simultaneously being created".
- Recommendation:
  - Poll `/device/availability` every 30–60 s with jitter. That is one cheap GET.
  - Send `POST /server` only when `amount >= 1`, or at most every 2–5 minutes as a blind attempt.
  - Back off exponentially on 429, 5xx and `SERVER_CREATING_LIMIT_REACHED`.

---

## 10. Spot GPU pricing

- How to request it: **there is no separate field. Spot is a plan name.** "Spot identifiers insert `SPOT` after `GPU`, e.g., `GPU-SPOT-8xCPU-64GB-1xL40S`" [PROD configurations]. You send it as `"plan": "GPU-SPOT-..."` in `POST /1.3/server`.
  - For 8×H100 that rule gives `GPU-SPOT-96xCPU-1920GB-8xH100` (UNVERIFIED). Confirm the name in `GET /1.3/plan` before use.
- Coverage:
  - The changelog of 06.07.2026 introduced spot only for L40S and B200.
  - The current configurations page says spot is "available for all plans".
  - The pricing page lists a spot price for every GPU plan, including 8×H100 at 14.32 vs 17.36 EUR/h.
- What spot means [PROD spot, faq]:
  - The hardware and performance are the same as on-demand.
  - UpCloud can reclaim the capacity when on-demand needs it. It sends an ACPI shutdown, gives a **30-second** window, then forces power-off. The server ends up `stopped`.
  - Persistent storage and IPs are kept. RAM and temporary data are lost.
  - Billed hourly while on. If UpCloud stops the instance, you get credits for the unused part of that hour.
  - No SLA. Interruptions cluster at peak times. "Spot capacity may not always be available."
  - **A standard instance cannot be converted to spot.** You create a new one and move the disks.
  - Not recommended for time-critical work. For a competition deadline, on-demand is the safer choice.

---

## 11. Gotchas for a Worker that retries GPU server creation every N seconds

1. **Check capacity first, don't hammer creation.**
   - `GET /1.3/device/availability` → `["fi-hel2"].gpu_plans["GPU-96xCPU-1920GB-8xH100"].amount`. Fire `POST /server` only when it is ≥ 1.
   - Keep a slow blind retry as a fallback, because the meaning of `amount` is UNVERIFIED.
2. **Is a failed creation free, and does it leave storage behind?**
   - Not documented.
   - A 409 `SERVER_RESOURCES_UNAVAILABLE` is returned synchronously, in place of a 202, so most likely nothing is created and nothing is billed (UNVERIFIED).
   - Still, label every attempt (`managedBy=gpu-sniper`). After every non-2xx response, and once an hour, run `GET /1.3/server/?label=managedBy=gpu-sniper` and `GET /1.3/storage/private`. Delete orphans, especially disks titled like your OS disk.
   - Every orphan MaxIOPS GB costs 0.22 EUR per month, billed hourly.
3. **Idempotency and duplicates.**
   - The API has no idempotency key.
   - If a POST times out in the Worker, the server may still have been created. Before retrying, list servers by label.
   - Use a lock (Durable Object, or a KV flag plus a check) so that only one creation runs at a time.
   - After success, stop the loop immediately. A second 8×H100 server costs 17.36 EUR/h.
4. **The create call is asynchronous.** You get 202 with `state: maintenance`. Poll `GET /server/{uuid}` until `started`. If it reaches `error`, alert.
5. **Fatal versus retryable errors.**
   - Retry: 409 `SERVER_RESOURCES_UNAVAILABLE` / `STORAGE_RESOURCES_UNAVAILABLE` / `IP_ADDRESS_RESOURCES_UNAVAILABLE` / `SERVER_CREATING_LIMIT_REACHED`, and 5xx.
   - Stop and alert: 401, 402 `INSUFFICIENT_CREDITS`, any 403 `*_LIMIT_REACHED`, 400 and validation 409s.
6. **Check the account before the race** with `GET /1.3/account`:
   - `resource_limits.gpus >= 8`.
   - `cores >= 96` and `memory >= 1966080` MiB, plus your other servers.
   - `credits` large enough. Credits are deducted hourly: 24 h of 8×H100 is about 417 EUR plus VAT.
   - Promotional credits do not count for GPUs.
   - Ask support in advance to raise the GPU, core and memory limits.
7. **"Pre-warm and switch plan" strategy (often better than blind creation).**
   - Create the server ahead of time on a small plan (ideally a 1×L4 GPU plan) with the AI/ML template, storage and network, set it up, then stop it.
   - While it is stopped you pay only for storage and IP.
   - When capacity appears, run `PUT /server/{uuid}` with `plan=GPU-96xCPU-1920GB-8xH100`, then `POST /server/{uuid}/start`. On 409 `SERVER_RESOURCES_UNAVAILABLE`, switch the plan back if needed and retry later.
   - This saves the OS install time.
   - Caveats: plan changes require `stopped`; billing is per started hour; switching from a non-GPU plan to a GPU plan is UNVERIFIED.
8. **Each start bills a full hour.** Never run a start/stop flapping loop on a GPU plan.
9. **Template and cloud-init requirements.** `metadata: "yes"`, `login_user.ssh_keys` filled, `create_password` absent or `"no"`, lower-case `hostname`, explicit storage `size` and `tier` (GPU plans include no disk).
10. **Error parsing.** Handle both the legacy `{"error":{...}}` format and `application/problem+json`. Log the full body: the human-readable `error_message` may name the exact limit that was hit.
11. **Token hygiene.** Use a dedicated token with `can_create_tokens: false`, keep it in Worker secrets, and alert before `expires_at` (365 days at most).
12. **Spot fallback.** If on-demand H100 stays unavailable, also watch the spot plan names. Spot can be interrupted with 30 s notice, so checkpoint often.
