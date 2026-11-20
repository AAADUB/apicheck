# Nebius AI Cloud API: REST notes for a Cloudflare Worker GPU sniper

Researched 20.11.2026. Sources:
- Protos: `github.com/nebius/api` @ `38f7a46` (19 Nov 2026). Cloned locally, so field names are quoted from the files.
- SDKs: `nebius/pysdk` @ `0169855` (19 Nov 2026), `nebius/gosdk` (auth package, main).
- Docs: `docs.nebius.com/*.md`, read through WebFetch. WebFetch paraphrases prose, but quotes code and identifiers literally.
- OpenAPI: `https://api.nebius.cloud/openapi.json`. The sandbox proxy blocks this host, so I read it through Firecrawl's extraction (LLM query mode). The path list and parameter names are consistent with the protos, but download the real file once from a normal machine and diff it before you ship.

Legend:
- **[proto]**: quoted from a .proto file.
- **[openapi]**: from openapi.json.
- **[docs]**: from docs.nebius.com.
- **[sdk]**: from SDK source.
- **[unverified]**: inference. It is not documented anywhere I could reach.

---

## 1. REST API basics

### Host and URL pattern
- REST runs on one global host: **`https://api.nebius.cloud`** [openapi `servers`; docs quickstart example `GET https://api.nebius.cloud/iam/v1/profiles`].
- It is not per-service and not per-region. (gRPC uses per-service hosts such as `compute.api.nebius.cloud:443`; see `endpoints.md` in nebius/api.)
- The region comes from the project, so `parentId=project-...` selects it. No regional REST endpoint is documented. pysdk also uses one domain, `DOMAIN = "api.nebius.cloud:443"` [sdk `nebius/base/constants.py`].
- Path pattern: `/{service}/{version}/{resource-kebab-plural}[/{id}|/{verb-kebab}]` [openapi].
- REST is HTTP/1.1 with JSON. It is generated from the same protos as gRPC [docs rest-api/index].

### Method mapping (from the openapi path list)

| gRPC | HTTP | Path example |
|---|---|---|
| `Create` | `POST` | `/compute/v1/instances` (body = `CreateInstanceRequest` JSON) |
| `List` | `GET` | `/compute/v1/instances?parentId=project-...&pageSize=&pageToken=` |
| `Get` | `GET` | `/compute/v1/instances/{id}` |
| `GetByName` | `GET` | `/compute/v1/instances/get-by-name?parentId=...&name=...` |
| `Update` | `PATCH` | `/compute/v1/instances` (body has `metadata.id`; full replace plus `X-ResetMask`, see the nebius/api README) |
| `Delete` | `DELETE` | `/compute/v1/instances/{id}` |
| `Start` / `Stop` | `POST` | `/compute/v1/instances/start`, `/compute/v1/instances/stop` (body `{"id":"computeinstance-..."}`) [unverified body shape; it follows `StartInstanceRequest{id}`] |
| `OperationService.Get` | `GET` | `/compute/v1/instances/operations/{id}` (also `/compute/v1/disks/operations/{id}`, `/compute/v1/filesystems/operations/{id}`, ...) |
| `OperationService.List` | `GET` | `/compute/v1/instances/operations?resourceId=...` |

### Paths you need [openapi]

```
GET    /iam/v1/profiles                        ProfileService_Get
GET    /iam/v1/tenants                         TenantService_List          (pageSize, pageToken, filter)
GET    /iam/v1/tenants/{id}
GET    /iam/v1/projects                        ProjectService_List         (parentId, pageSize, pageToken, filter)
GET    /iam/v1/projects/{id}
GET    /iam/v1/projects/get-by-name
GET    /capacity/v1/resource-advice            ResourceAdviceService_List  (parentId=tenant-..., pageSize, pageToken)
GET    /quotas/v1/quota-allowances             QuotaAllowanceService_List  (parentId, pageSize, pageToken)
GET    /quotas/v1/quota-allowances/get-by-name (parentId, name, region per proto)
GET    /quotas/v1/quota-allowances/{id}
GET    /compute/v1/platforms                   PlatformService_List        (parentId=project-..., pageSize, pageToken)
GET    /compute/v1/platforms/get-by-name
GET    /compute/v1/images/get-latest-by-family ImageService_GetLatestByFamily (imageFamily, parentId)
GET    /compute/v1/images/list-public          ImageService_ListPublic     (region, pageSize, pageToken)
POST   /compute/v1/disks  | GET /compute/v1/disks?parentId= | GET|DELETE /compute/v1/disks/{id} | GET /compute/v1/disks/operations/{id}
POST   /compute/v1/filesystems | GET ?parentId= | GET|DELETE /compute/v1/filesystems/{id} | GET /compute/v1/filesystems/operations/{id}
POST   /compute/v1/gpu-clusters | GET ?parentId= | GET|DELETE /compute/v1/gpu-clusters/{id}
POST   /compute/v1/instances | GET ?parentId= | GET|DELETE /compute/v1/instances/{id} | GET /compute/v1/instances/get-by-name
POST   /compute/v1/instances/start | POST /compute/v1/instances/stop
GET    /compute/v1/instances/operations/{id}
GET    /vpc/v1/subnets                         SubnetService_List (parentId, pageSize, pageToken)
GET    /vpc/v1/networks/get-default            NetworkService_GetDefault
GET    /billing/v1alpha1/spot-price            SpotPriceService_List (spot prices for preemptibles)
```

The openapi has no path for the token exchange. Token exchange lives on the auth host (section 2).

### JSON conventions
- JSON property names and query parameters are **camelCase**: `parentId`, `pageSize`, `pageToken`, `imageFamily`, `bootDisk`, `cloudInitUserData`, `networkInterfaces`, `gpuCluster`, `secondaryDisks`, `serviceAccountId`, `followsSpotPrice`, `reservationPolicy` [openapi].
- Standard proto3-JSON behaviour also applies [unverified that the gateway accepts snake_case input as well; send camelCase]:
  - Enums are strings (`"READ_WRITE"`, `"NETWORK_SSD"`).
  - `int64` values may come back as strings (for example `"sizeBytes":"1073741824"`).
  - Timestamps are RFC 3339.
- Auth header: `Authorization: Bearer <IAM access token>` [docs; openapi `securitySchemes.bearerAuth`].
- Idempotency: send the `X-Idempotency-Key: <uuid>` header on mutating calls; `Get` and `List` ignore it [nebius/api README]. Use it on every `POST /compute/v1/instances` so retries never create twins.
- No concurrent operations on the same resource. A parallel operation may error out or abort the earlier one [README].

### Long-running Operations
Mutating calls return `nebius.common.v1.Operation` [proto `common/v1/operation.proto`]:

```json
{
  "id": "...", "description": "...", "createdAt": "...", "createdBy": "...",
  "finishedAt": "...",
  "request": {"@type": "..."},
  "requestHeaders": {"x-idempotency-key": {"values": ["..."]}},
  "resourceId": "computeinstance-...",
  "status": {"code": 0, "message": "...", "details": [ ... ]},
  "progressTracker": { ... },
  "progressData": { ... }
}
```

- **The operation is complete only once `status` is set.** `status == null` means it is still running. A completed operation also has `finishedAt` [README + proto].
- `status.code` is the gRPC canonical code. 0 means success.
- Operation-compatible codes are `OK, CANCELLED, PERMISSION_DENIED, RESOURCE_EXHAUSTED, FAILED_PRECONDITION, ABORTED, INTERNAL` [proto comment].
- `status.details` holds `nebius.common.v1.ServiceError` entries.
- A synchronous operation may come back already completed [README].
- Poll with `GET /compute/v1/instances/operations/{operationId}`. The same service must serve the operation: for a disk operation, use `/compute/v1/disks/operations/{id}`.
- pysdk's default `wait()` interval is 1 s [sdk `aio/operation.py`]. Completed operations may be deleted under the retention policy [README].
- `resourceId` gives the new instance ID right away, so you can `GET /compute/v1/instances/{id}` while the operation runs.

### Error format
- REST error body [docs rest-api/errors]: `{"code":3, "message":"invalid resource size type: <nil>"}`. The docs example has no `details` array. Parse `details` defensively in case it appears.
- Codes (gRPC → HTTP) [docs]:

| gRPC | HTTP | Meaning |
|---|---|---|
| 1 CANCELLED | 499 | |
| 3 INVALID_ARGUMENT | 400 | |
| 4 DEADLINE_EXCEEDED | 504 | May have succeeded; check state before retrying |
| 5 NOT_FOUND | 404 | |
| 6 ALREADY_EXISTS | 409 | |
| 7 PERMISSION_DENIED | 403 | Valid credentials, missing role |
| 8 RESOURCE_EXHAUSTED | 429 | Docs: "The quotas of the requested resources are exhausted." |
| 9 FAILED_PRECONDITION | 400 | Docs: "The request can't be performed because of the current state of resources." |
| 10 ABORTED | 409 | Concurrency or version conflict |
| 11 OUT_OF_RANGE | 400 | |
| 13 INTERNAL | 500 | |
| 14 UNAVAILABLE | 503 | Retry later |
| 16 UNAUTHENTICATED | 401 | Bad or expired token |

  Nebius never returns 2, 12 or 15.
- `ServiceError` [proto `common/v1/error.proto`] has these fields:
  - `service`
  - `code`: a string such as `"DnsZoneNotEmpty"`
  - `retryType`: `UNSPECIFIED|CALL|UNIT_OF_WORK|NOTHING`
  - a oneof detail: `badRequest`, `badResourceState`, `resourceNotFound`, `resourceAlreadyExists`, `outOfRange`, `permissionDenied`, `resourceConflict`, `operationAborted`, `operationConflict`, `tooManyRequests{violation}`, `quotaFailure{violations[{quota,message,limit,requested,region}]}`, **`notEnoughResources{violations[{resourceType,message,requested}]}`**, `internalError{requestId,traceId}`.
- **Capacity error text:** "Not enough resources". It appears on create and on restarting a stopped VM [docs compute/virtual-machines/not-enough-resources, create].
- **Which numeric code carries it is not documented.** The docs map RESOURCE_EXHAUSTED (8) only to quota. The proto has a dedicated `NotEnoughResources` detail type, separate from `QuotaFailure`. pysdk retries RESOURCE_EXHAUSTED and UNAVAILABLE by default [sdk `aio/service_error.py` `DefaultRetriableCodes`].
- Treat it as capacity-unavailable if any of these hold, and tell it apart from quota by the detail type:
  - `code ∈ {8, 9}` and (`message` matches `/not enough resources/i` or `details[].notEnoughResources` is present);
  - or HTTP 429 without `quotaFailure`.

---

## 2. Service-account authentication (no browser)

### Credentials file
Produced by [docs iam/service-accounts/authorized-keys]:
```
nebius iam auth-public-key generate --service-account-id $SA_ID --output ~/.nebius/$SA_ID-credentials.json
```
Format [sdk gosdk `auth/service_account.go`, pysdk `base/service_account/credentials_file.py`]:
```json
{
  "subject-credentials": {
    "type": "JWT",
    "alg": "RS256",
    "private-key": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n",
    "kid": "publickey-...",
    "iss": "serviceaccount-...",
    "sub": "serviceaccount-..."
  }
}
```
- `type` is optional; if present it must be `"JWT"`.
- `alg` must be `RS256`. `iss` must equal `sub`.
- gosdk comment: "private-key": "PKCS#8 PEM with new lines escaped as \n".

### Manual key pair
Alternative [docs rest-api/authentication]:
```
openssl genrsa -out private.pem 4096 && openssl rsa -in private.pem -outform PEM -pubout -out public.pem
nebius iam auth-public-key create --account-service-account-id <SA_ID> --data "$(cat public.pem)" --expires-at <ts>
```
- OpenSSL 3.x `genrsa` writes PKCS#8 (`-----BEGIN PRIVATE KEY-----`). I checked this locally with OpenSSL 3.0.13.
- OpenSSL 1.1 and `-traditional` write PKCS#1 (`BEGIN RSA PRIVATE KEY`), which WebCrypto cannot import. Convert it with `openssl pkcs8 -topk8 -nocrypt -in private.pem -out pk8.pem`.
- REST is also available: `POST /iam/v1/auth-public-keys` [openapi].

### Prerequisites
- The service account must be in a group with a role on the tenant or project. Docs say `editor` is usually enough [docs rest-api/authentication].
- The capacity advisor needs at least `viewer` on the **tenant** [docs capacity-advisor].

### JWT
SDKs build it like this [gosdk `auth/exchangable.go`, pysdk `service_account.py`]:
- Header: `{"alg":"RS256","typ":"JWT","kid":"<publickey-...>"}`
- Claims: `{"iss":"<serviceaccount-...>","sub":"<serviceaccount-...>","aud":"token-service.iam.new.nebiuscloud.net","iat":<now>,"exp":<now+60>}`
- The SDKs use a 1-minute TTL. Docs and README examples use 5 minutes with only `kid/iss/sub/exp` and no `aud`. Use the SDK form: it is what production clients send.
- Sign RS256 (RSASSA-PKCS1-v1_5 + SHA-256) and base64url-encode without padding.

### Token exchange
Over HTTP [docs rest-api/authentication; nebius/api README]:
```
POST https://auth.eu.nebius.com:443/oauth2/token/exchange
Content-Type: application/x-www-form-urlencoded

grant_type=urn:ietf:params:oauth:grant-type:token-exchange
&requested_token_type=urn:ietf:params:oauth:token-type:access_token
&subject_token=<JWT>
&subject_token_type=urn:ietf:params:oauth:token-type:jwt
```
Response:
```json
{"access_token":"...","issued_token_type":"urn:ietf:params:oauth:token-type:access_token","token_type":"Bearer","expires_in":43200}
```
- The token lives 12 h (43200 s). Cache it, for example in KV, and refresh about 1 h before expiry.
- The gRPC equivalent is `nebius.iam.v1.TokenExchangeService/Exchange` on `tokens.iam.api.nebius.cloud:443`, with the same fields [proto `iam/v1/token_service.proto`].
- `api.nebius.cloud` has no REST path for the exchange; use `auth.eu.nebius.com`. It is the single global endpoint for all regions. pysdk also hardcodes `auth.eu.nebius.com` for federation.

### WebCrypto (Cloudflare Workers)
PKCS#8 imports directly:
```ts
const der = b64decode(pem.replace(/-----[^-]+-----|\s/g, ""));
const key = await crypto.subtle.importKey("pkcs8", der, {name:"RSASSA-PKCS1-v1_5", hash:"SHA-256"}, false, ["sign"]);
const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${h}.${p}`));
```
- `importKey("pkcs8", ...)` with RSASSA-PKCS1-v1_5/SHA-256 is standard WebCrypto and is supported in Workers.
- PKCS#1 is not supported, which is one more reason to use the CLI-generated file (PKCS#8 per the gosdk comment).
- Store the private key as a Worker secret, never in code.

---

## 3. Discovery: tenants, projects, regions

- `GET /iam/v1/tenants` returns `{"items":[Container], "nextPageToken"}`. The default page size is 10 [proto].
- `GET /iam/v1/projects?parentId=tenant-...` returns `{"items":[Container]}`.
- `Container` [proto `iam/v1/container.proto`]:
  - `metadata{id,parentId,name,...}`
  - `spec{region}`
  - `status{suspensionState, containerState, region}`
- **Projects are tied to regions.** "Nebius AI Cloud provides you with a project per region when you sign up" [docs overview/regions]. Pick the project whose `spec.region` / `status.region` matches the target region, then pass `parentId=project-...` for compute and vpc calls.
- The capacity advisor and quota allowances take the **tenant** ID. Quotas also accept a project ID.
- Regions [docs overview/regions]:

| Region | Location | Access |
|---|---|---|
| `eu-north1` | Finland | Public |
| `eu-south1` | Madrid | Public |
| `eu-west1` | France | Public |
| `eu-west2` | France | Public |
| `me-west1` | Israel | Public |
| `us-central1` | Kansas City | Public |
| `us-north1` | Woodbury, MN | Public |
| `uk-south1` | UK | Public |
| `uk-south2` | UK | Public |
| `eu-north2` | Iceland | Private, existing deployments only |

- The REST endpoint is the same for every region.

---

## 4. Platforms and presets

### API
- `GET /compute/v1/platforms?parentId=project-...` returns `ListPlatformsResponse{items[], nextPageToken}`. `parentId` is required.
- `Platform` [proto `compute/v1/platform.proto`]:
```
metadata{ name: "gpu-h100-sxm", ... }
spec{
  presets[]{ name, resources{ vcpuCount, memoryGibibytes, gpuCount }, allowGpuClustering }
  gpuCountQuotaType, humanReadableName, allowPresetChange, shortHumanReadableName, gpuMemoryGigabytes
}
status{ allowedForPreemptibles }
```
- GPU memory sits at platform level only (`gpuMemoryGigabytes`); presets have no per-preset GPU memory.
- `allowGpuClustering` marks the presets that can join an InfiniBand cluster.

### GPU platforms and presets (as of 20.11.2026)
From [docs compute/virtual-machines/types]:

| Platform | GPU | Regions | Presets (GPUs/vCPU/GiB) |
|---|---|---|---|
| `gpu-h100-sxm` | H100 | eu-north1 | `1gpu-16vcpu-200gb`, `8gpu-128vcpu-1600gb` |
| `gpu-h200-sxm` | H200 | eu-north1, eu-west1, us-central1, eu-north2 (private) | `1gpu-16vcpu-200gb`, `8gpu-128vcpu-1600gb` |
| `gpu-b200-sxm` | B200 | us-central1 | `1gpu-20vcpu-224gb`, `8gpu-160vcpu-1792gb` |
| `gpu-b200-sxm-a` | B200 | me-west1 | same as `gpu-b200-sxm` |
| `gpu-b300-sxm` | B300 | uk-south1, eu-west2, us-north1 | `1gpu-24vcpu-346gb`, `8gpu-192vcpu-2768gb` |
| `gpu-rtx6000` | RTX PRO 6000 | us-central1 | `1gpu-24vcpu-218gb`, `8gpu-192vcpu-1744gb` |
| `gpu-rtx6000-a` | RTX PRO 6000 | uk-south2, eu-south1 | same as `gpu-rtx6000` |
| `gpu-l40s-a` | L40S (Intel) | eu-north1 | `1gpu-8vcpu-32gb` … `1gpu-40vcpu-160gb` |
| `gpu-l40s-d` | L40S (AMD) | eu-north1 | `1gpu-16vcpu-96gb` … `4gpu-192vcpu-1152gb` |

- Only the 8-GPU presets of h100, h200, b200(-a) and b300 are GPU-cluster (InfiniBand) compatible.
- GB200/GB300 do not appear on the types page.

### Prices (USD per GPU-hour)
From [docs compute/resources/pricing]:

| GPU | On-demand | Preemptible (dynamic spot since 8 Oct 2026, "from") |
|---|---|---|
| B300 | $9.50 | $0.99 |
| B200 | $8.50 | $0.99 |
| H200 | $5.40 | $0.79 |
| H100 | $4.50 | $0.79 |
| RTX PRO 6000 | $1.80 | $0.79 |
| L40S | $1.35 | $0.65, plus separate vCPU/RAM prices |

- On-demand prices went up on 1 Oct 2026. Before that: B300 $7.85, B200 $7.15, H200 $4.50, H100 $3.85.
- The page lists only a GPU-hour price for the NVLink platforms, with no separate vCPU/RAM lines. It does not explicitly state that 8× preset = 8 × GPU price; presumably 8×H100 ≈ $36/h on-demand [unverified].
- Spot prices are readable at `GET /billing/v1alpha1/spot-price` (docs signup-billing/spot-prices).
- Storage (per GiB per 730 h):

| Item | Price |
|---|---|
| Network SSD | $0.071 |
| Network SSD Non-replicated | $0.053 |
| Network SSD IO M3 | $0.118 |
| Shared Filesystem SSD | $0.08 |
| Local SSD | $0.065 |
| Snapshot | $0.071 |

---

## 5. Capacity advisor and quotas

### Capacity advisor
`GET https://api.nebius.cloud/capacity/v1/resource-advice?parentId=<tenant-...>&pageSize=&pageToken=` [openapi; proto `capacity/v1/resource_advice_service.proto`].
- gRPC host: `capacity-advisor.billing-cpl.api.nebius.cloud`.
- `parentId` must be the **tenant** ID. It is used to clip `available` by your quota.
- Response: `{"items":[ResourceAdvice], "nextPageToken"}`. Schema [proto `capacity/v1/resource_advice.proto`]:
```
ResourceAdvice {
  metadata { parentId: "tenant-..." ... }            // UNNAMED resource
  spec {
    region: "eu-north1",
    fabric: "fabric-3",                              // data-center fabric / cluster id
    computeInstance {
      platform: "gpu-h100-sxm",
      preset { name: "8gpu-128vcpu-1600gb", resources { vcpuCount, memoryGibibytes, gpuCount } },
      gpuMemoryGigabytes
    }
  }
  status {
    reserved    { dataState, available, limit, availabilityLevel, effectiveAt },
    onDemand    { ... same ... },
    preemptible { ... same ... }
  }
}
```
- `available` (uint32): "Current units that can be allocated immediately (clipped by quota)". Docs: the maximum number of VMs you can launch.
- `limit` (uint32): "The user's maximum quota limit for this resource type."
- `availabilityLevel` values:

| Value | Number | Meaning |
|---|---|---|
| `AVAILABILITY_LEVEL_UNSPECIFIED` | 0 | |
| `AVAILABILITY_LEVEL_HIGH` | 1 | "Plenty of room" |
| `AVAILABILITY_LEVEL_MEDIUM` | 2 | |
| `AVAILABILITY_LEVEL_LOW` | 3 | "High risk of Not Enough Resources (NER)" |
| `AVAILABILITY_LEVEL_LIMIT_REACHED` | 4 | "Not enough quota or capacity block on the customer's side"; docs: "Launch impossible" |
| `AVAILABILITY_LEVEL_UNKNOWN` | 5 | |

- `dataState` values:

| Value | Number |
|---|---|
| `DATA_STATE_UNSPECIFIED` | 0 |
| `DATA_STATE_FRESH` | 1 |
| `DATA_STATE_STALE` | 2 |
| `DATA_STATE_UNKNOWN` | 10 |

- `effectiveAt` is the timestamp of the actual infrastructure measurement.
- Each item is one region × fabric × platform × preset, so a platform/preset can show up as several items (one per fabric). Sum or OR across fabrics when not using a GPU cluster.
- **Refresh frequency is not documented.** Rely on `effectiveAt` and `dataState`.
- Caveats [docs]:
  - It covers GPU VMs only and does not guarantee availability at create time.
  - Preemptible figures assume "follows spot price".
  - No chance-of-launch indicator is shown for reserved capacity.
  - Terraform does not support it.
  - CLI: `nebius capacity resource-advice list --parent-id <tenant_ID>`.

### Quotas
`GET /quotas/v1/quota-allowances?parentId=<tenant-...|project-...>` [openapi; proto `quotas/v1/*`].
- gRPC host: `quota-dispatcher.billing-cpl`.
- Item: `metadata{id,parentId,name}`, `spec{limit (uint64, optional), region}`, `status{...}`.
- `status` fields:
  - `state`: `STATE_PROVISIONING|STATE_ACTIVE|STATE_FROZEN|STATE_DELETED`
  - `usage`, `service`, `description`, `serviceDescription`, `unit`
  - `usagePercentage` (string)
  - `usageState`: `USAGE_STATE_USED|NOT_USED|UNKNOWN|NOT_APPLICABLE`
- `GET /quotas/v1/quota-allowances/get-by-name?parentId=&name=&region=`. The proto's example name is `"compute.disk.size.network-ssd"`.
- **Exact GPU quota names are not documented.** List the allowances and match on `metadata.name`/`status.description`. Also check `Platform.spec.gpuCountQuotaType`, which probably holds the quota key [unverified].
- Default GPU quotas per region [docs compute/resources/quotas-limits]:
  - H100 eu-north1: 32 GPUs
  - H200: eu-north1 32, eu-west1 8, us-central1 0
  - B300: 32 in each of uk-south1, eu-west2, us-north1
  - B200: 0 (me-west1, us-central1)
  - RTX PRO 6000: uk-south2 32, eu-south1 32, us-central1 0
  - L40S: 32
  - GPU VMs: 12 regular and 8 preemptible per region
  - Disks 32, shared filesystems 32, GPU clusters 5
  - Disk and filesystem capacity: 4 TiB in eu-north1, 2 TiB in eu-west1, 5 TiB elsewhere
- Stopped VMs still hold quota; only deletion frees it [docs lifecycle].
- Increases go through the console (Administration → Limits → Quotas → Change quota, admin role) [docs overview/quotas].

---

## 6. Creating a VM over REST

### (a) Boot disk
**No separate disk is needed.** `bootDisk.managedDisk` creates the disk inline, and the VM deletes it on deletion [proto `AttachedDiskSpec.managed_disk`; docs create: "all create a VM-managed boot disk inline"].
- `managedDisk` = `{name (required), labels, spec: DiskSpec (required)}`.
- Instance create fails if a disk with the same `name` already exists. Use a unique name per attempt, or always delete the failed instance first.

`DiskSpec` [proto `compute/v1/disk.proto`]:
- size: oneof `sizeBytes|sizeKibibytes|sizeMebibytes|sizeGibibytes` (required)
- `blockSizeBytes`
- `type` (required): `NETWORK_SSD|NETWORK_HDD|NETWORK_SSD_NON_REPLICATED|NETWORK_SSD_IO_M3`
- source: oneof `sourceImageId | sourceImageFamily{imageFamily (required), parentId} | sourceSnapshotId`
- `diskEncryption{type}`, `forbidDeletion`

Size limits [docs storage/types]:
- Network SSD: 1 GiB to 8 TiB.
- Non-replicated and IO M3: multiples of 93 GiB.
- Maximum boot disk size is 30,720 GiB [docs create].

A standalone disk is also possible: `POST /compute/v1/disks` with `{"metadata":{"parentId","name"},"spec":{...DiskSpec}}`, then `existingDisk{id}`. That disk survives VM deletion.

### (b) Network
- `GET /vpc/v1/subnets?parentId=project-...` and take `items[0].metadata.id`.
- `GET /vpc/v1/networks/get-default` also exists.
- Every project gets a default network and subnet at signup [unverified wording; docs create examples use `<subnet_ID>`].

### (c) Instance create body
`POST https://api.nebius.cloud/compute/v1/instances`, built from the fields in [proto `compute/v1/instance.proto`, `network_interface.proto`]:
```json
{
  "metadata": { "parentId": "project-e00...", "name": "sniper-h100-1", "labels": {"owner":"sniper"} },
  "spec": {
    "resources": { "platform": "gpu-h100-sxm", "preset": "8gpu-128vcpu-1600gb" },
    "bootDisk": {
      "attachMode": "READ_WRITE",
      "managedDisk": {
        "name": "sniper-h100-1-boot",
        "spec": {
          "type": "NETWORK_SSD",
          "sizeGibibytes": "200",
          "sourceImageFamily": { "imageFamily": "ubuntu24.04-cuda13.0" }
        }
      },
      "deviceId": "boot"
    },
    "networkInterfaces": [
      { "name": "eth0", "subnetId": "vpcsubnet-...", "ipAddress": {}, "publicIpAddress": {} }
    ],
    "filesystems": [
      { "attachMode": "READ_WRITE", "mountTag": "data", "existingFilesystem": { "id": "computefilesystem-..." } }
    ],
    "cloudInitUserData": "#cloud-config\nusers:\n - name: ubuntu\n   sudo: ALL=(ALL) NOPASSWD:ALL\n   shell: /bin/bash\n   ssh_authorized_keys: [\"ssh-ed25519 AAAA...\"]\nruncmd:\n - mkdir -p /mnt/data\n - mount -t virtiofs data /mnt/data\n - echo 'data /mnt/data virtiofs rw,nofail 0 0' >> /etc/fstab\n",
    "recoveryPolicy": "RECOVER",
    "onDemand": {}
  }
}
```

Field reference (`InstanceSpec`):

| Field | Notes |
|---|---|
| `serviceAccountId` | IMMUTABLE |
| `resources{platform (required, IMMUTABLE), preset (required oneof size)}` | The platform/preset sit under `resources`, not at the top of `spec` |
| `gpuCluster{id}` | IMMUTABLE; can only be set at create |
| `networkInterfaces[]` | Required, max 8 |
| `networkInterfaces[].name` | Required, regex `^[0-9a-z][0-9a-z-]*$`, ≤ 60 chars |
| `networkInterfaces[].subnetId` | |
| `networkInterfaces[].ipAddress{allocationId?}` | Required; send `{}` |
| `networkInterfaces[].publicIpAddress{allocationId?, static}` | `{}` = dynamic, `{"static":true}` = static; omit for private-only |
| `networkInterfaces[].aliases[]`, `securityGroups[{id}]` | |
| `bootDisk` | Required; `AttachedDiskSpec{attachMode READ_ONLY\|READ_WRITE (required), existingDisk{id} \| managedDisk{...}, deviceId (≤ 20 chars)}` |
| `secondaryDisks[]` | `AttachedDiskSpec` |
| `filesystems[]` | `{attachMode, mountTag (required, ≤ 37 chars), existingFilesystem{id}}` |
| `cloudInitUserData` | ≤ 32768 chars, sensitive |
| `stopped` | bool; create without starting |
| `recoveryPolicy` | `RECOVER` (default 0) \| `FAIL` \| `ALWAYS` (NVL groups only); IMMUTABLE |
| `preemptible{onPreemption:"STOP" (required), priority (deprecated since 2026-05-11, no effect)}` | |
| `hostname` | regex `^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$` |
| `nvlInstanceGroupId` | |
| `reservationPolicy{policy: AUTO\|FORBID\|STRICT, reservationIds[]}` | AUTO (default): reservations, then any capacity block, then PAYG. FORBID: PAYG only. STRICT: blocks only |
| `localDisks{passthroughGroup{requested:true}}` | |
| pricing oneof: `onDemand{}` (default) \| `followsSpotPrice{}` \| `spotPricingPolicy{id}` | |

Preemptible create:
- Set `"preemptible":{"onPreemption":"STOP"}`, `"followsSpotPrice":{}` (or `spotPricingPolicy`) and **`"recoveryPolicy":"FAIL"`**. `RECOVER` errors for preemptibles [docs preemptible].
- The VM gets SIGTERM 60 s before it is stopped. On preemption it is stopped, not deleted. A dynamic public IP is released [docs].

Instance states [proto `InstanceStatus.InstanceState`]:
- `UNSPECIFIED, CREATING, UPDATING, STARTING, RUNNING, STOPPING, STOPPED, DELETING, ERROR`
- Plus `status.reconciling` (bool, an operation is in flight), `status.networkInterfaces[].publicIpAddress.address`, `status.diskAttachments[]`, `status.reservationId`.
- In docs: create goes Stopped→Starting→Running. ERROR cannot be recovered: "delete this VM and create a new one" [docs lifecycle].
- Billing starts at Running [docs lifecycle].

**When capacity runs out:**
- Docs say only that creation (or restart of a stopped VM) fails with "Not enough resources". They do not say whether this happens synchronously (HTTP error on POST) or asynchronously (Operation `status.code != 0`), nor what state the instance resource is left in [docs not-enough-resources, lifecycle].
- Create returns an Operation. Validation and quota errors usually come back synchronously; placement failures typically arrive as a failed Operation [unverified].
- Robust handling:
  1. POST with an `X-Idempotency-Key`.
  2. If the HTTP response is 4xx/5xx, classify it per section 1.
  3. Otherwise poll the Operation until `status` is set.
  4. On failure, `GET /compute/v1/instances/get-by-name?parentId&name`. If an instance exists (STOPPED/ERROR), `DELETE` it. That also deletes the managed boot disk. Wait for the delete Operation before retrying with the same names.
  5. Also handle `status.state` staying `STARTING` with `reconciling:true` for a long time.

---

## 7. Shared filesystems

- `POST /compute/v1/filesystems` with this body [proto `compute/v1/filesystem.proto`]:
  `{"metadata":{"parentId","name"},"spec":{"type":"NETWORK_SSD","sizeGibibytes":"1024"}}`
- Enum `FilesystemType`: `NETWORK_SSD`, `NETWORK_HDD`, `WEKA`, `VAST`. The proto says the list "is not final". The docs describe only the SSD type (`network_ssd`): 1 GiB to 100 PiB, up to 15/10 GiB/s per client [docs storage/types].
- Status: `state` = `CREATING|READY|UPDATING|DELETING|ERROR`, plus `readWriteAttachments[]`, `sizeBytes`.
- Attach at VM create with `spec.filesystems[]{attachMode, mountTag, existingFilesystem{id}}`. Mount inside the VM [docs storage/use]:
  ```
  mkdir /mnt/fs
  mount -t virtiofs filesystem-0 /mnt/fs
  echo "filesystem-0 /mnt/fs virtiofs rw,nofail 0 0" >> /etc/fstab
  ```
  The device is the `mountTag`. The docs give no cloud-init example; the `runcmd` in section 6 is built from these documented commands.
- Secondary disks appear as `/dev/disk/by-id/virtio-<deviceId>`.
- A filesystem survives VM deletion. That makes it the natural place for model weights between sniper attempts. Mind the default capacity quota of 4 TiB in eu-north1.

---

## 8. Images

- `GET /compute/v1/images/get-latest-by-family?imageFamily=ubuntu24.04-cuda13.0&parentId=` returns `Image`. Per the proto, `parentId` defaults to `project-{region}public-images`.
  - The literal ID format is not in the docs [unverified]. Simpler: rely on `sourceImageFamily{imageFamily}` in `DiskSpec`, whose `parentId` is optional.
- `GET /compute/v1/images/list-public?region=eu-north1` returns `{items:[Image], nextPageToken}`.
- `Image.spec` fields: `imageFamily, version, cpuArchitecture, imageFamilyHumanReadable, recommendedPlatforms[], unsupportedPlatforms{}, unsupportedPresets[{platform,preset,reason}]`.
- GPU families [docs compute/storage/boot-disk-images]:

| Family | OS | CUDA / driver | Status |
|---|---|---|---|
| `ubuntu24.04-cuda13.0` | Ubuntu 24.04 | CUDA 13.0, driver 580.x | Stable; recommended for B300, B200, H200, H100, RTX PRO 6000, L40S |
| `ubuntu24.04-cuda13-latest` | Ubuntu 24.04 | Latest 13.x | Rolling |
| `ubuntu24.04-cuda12` | Ubuntu 24.04 | CUDA 12.8, driver 570.x | Alternative for H200, H100, L40S |
| `ubuntu22.04-cuda12` | Ubuntu 22.04 | | **Deprecated; new disks from it are not supported** |
| `ubuntu24.04-driverless` | Ubuntu 24.04 | No driver | CPU family |
| `ubuntu22.04-driverless` | Ubuntu 22.04 | No driver | Deprecated |

  - The GPU images use kernel 6.11 and include NCCL, the NVIDIA Container Toolkit, DCGM and DOCA.
  - B200 `1gpu-20vcpu-224gb` needs driver 580.x or newer.

---

## 9. Delete, billing, quotas

- `DELETE /compute/v1/instances/{id}` returns an Operation. It "Also deletes all the managed disks, declared in the instance spec. Fails if cannot delete any of the managed disks" [proto instance_service.proto]. Deletion protection on a managed disk (`forbidDeletion`) makes it fail.
- An `existingDisk` is only detached; remove it with `DELETE /compute/v1/disks/{id}`.
- Billing [docs pricing, lifecycle]:
  - VMs are billed per second, priced per hour. Charging starts at Running and stops when the delete command is sent.
  - "Computing resources of stopped VMs are not charged". Disks and filesystems are billed on provisioned size per second, whether attached or not.
  - Public IP pricing is not on the compute pricing page (see the vpc pricing page).
  - A guest-OS shutdown is subject to the recovery policy and may keep billing. Stop through the API (docs page "stopped-with-linux-commands").
- Quotas for new accounts: see section 5. No explicit "self-service 32 GPU" policy is stated; 32 is the documented regional default for H100/H200 (eu-north1) and B300.
- Preemptible: priced at dynamic spot from 8 Oct 2026, "from" $0.79–0.99 per GPU-hour. There is a separate quota of 8 preemptible GPU VMs per region.

---

## 10. Gotchas

1. **A GPU cluster is optional for a single 8-GPU VM.** Docs: "(Optional) If you create a VM with 8 GPUs …, use a GPU cluster" [docs create]. InfiniBand needs one.
   - A cluster pins the VM to one fabric (`infinibandFabric`, for example `fabric-2/3/4/6` for H100 in eu-north1). That shrinks the placement pool, and "Each fabric has limited GPU capacity".
   - For a sniper, **omit `gpuCluster`** unless you need multi-node InfiniBand. The advisor reports per `fabric`, so you can see which fabric has room if you do need a cluster (`POST /compute/v1/gpu-clusters` with `{"metadata":{parentId,name},"spec":{"infinibandFabric":"fabric-3"}}`).
2. **Rate limits are not documented.** The error model has `TooManyRequests{violation}` and HTTP 429 / code 8. Back off on 429 and honour `retryType`. Polling the advisor every 30–60 s is reasonable; it reports `effectiveAt` anyway.
3. A stopped VM still holds quota and can fail to restart with "Not enough resources". Do not stop a sniped VM if you want to keep the GPUs.
4. Managed boot disk names must be unique in the project, or create fails. Idempotency keys protect against duplicate VMs on retry.
5. `ubuntu22.04-cuda12` is deprecated for new disks. Use `ubuntu24.04-cuda13.0` (or `ubuntu24.04-cuda12` for CUDA 12.8).
6. A token is valid for 12 h. Refresh before expiry. 401 means a bad token; 403 means a missing role.
7. `int64` fields (`sizeGibibytes`, `pageSize`) may be sent as JSON numbers or strings in proto3-JSON. Responses may return them as strings.
8. `resources.platform` and the boot disk spec are immutable. Changing the preset needs `allowPresetChange` on the platform.
9. Use one project per region. The Worker should map region to project ID once, via `/iam/v1/projects?parentId=tenant-...`.
10. Verify against the real `openapi.json` (blocked from this sandbox) before coding. The path list here came from an LLM extraction of that file and matched the protos everywhere I checked.
