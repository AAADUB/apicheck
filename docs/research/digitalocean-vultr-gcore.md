# DigitalOcean, Vultr, Gcore — read 21.11.2026

Need: 8x H100 SXM with at least 1600 GiB RAM, Europe or Middle East, availability and launch by API.

## DigitalOcean
- Sources: github.com/digitalocean/openapi (sizes, regions, droplets, account models); docs.digitalocean.com GPU availability, images, pricing.
- 8x H100: size `gpu-h100x8-640gb`, 160 vCPU, 1920 GiB RAM; on-demand $35.28/h (pricing doc, new prices from 01.08.2026).
- H100 on-demand datacenters: NYC2, AMS3, TOR1 (no FRA1/LON1). Europe = Amsterdam only.
- Signal: `GET /v2/sizes` → `available`, `regions` ("where this size is available for Droplet creates"). Not documented how fast a sold-out region leaves.
- Launch: `POST /v2/droplets` 202; create action can end `errored`. Image `gpu-h100x8-base` (8 GPU) / `gpu-h100x1-base`.
- `GET /v2/droplets` returns GPU Droplets only with `type=gpus`.
- Limits 5000/h, 250/min. Errors {id, message}.

## Vultr
- Sources: github.com/vultr/govultr (plan.go, region.go, bare_metal_server.go), vultr.com/api, docs.vultr.com (rate limits, access control).
- 8x H100: bare metal `vbm-112c-2048gb-8-h100-gpu` (2015 GiB RAM); Cloud GPU `vcg-h100-216c-1914gb-640vram` (1884 GiB). Trackers: ~$23.92/h; one source $18.40/h.
- Signal: `GET /v2/regions/{id}/availability` → `available_plans` ("currently available"), GPU plans included since 06.2022.
- Launch: `POST /v2/bare-metals` or `POST /v2/instances` {region, plan, os_id, label, sshkey_id[], user_data base64, tags}.
- 30 requests/s per IP. API key Access Control must allow any IPv4/IPv6 for Cloudflare.
- Not verified: which regions actually carry the H100 plans; whether new accounts need a deposit for GPU.

## Gcore
- Sources: github.com/G-Core/gcore-python (generated from Gcore OpenAPI), docs.gcore.com.
- 8x H100 IB bare metal: 2 TB RAM; Luxembourg, Finland (and others). Virtual GPU (8x H100 VM) launched in Sines-3, Portugal (03.2026).
- Signal: `GET /cloud/v3/gpu/{baremetal|virtual}/{project}/{region}/flavors` → `capacity` = available instances for the client; `include_prices=true`.
- Launch: `POST /cloud/v3/gpu/{kind}/{project}/{region}/clusters` {name, flavor, servers_count, image_id (bare metal), servers_settings{interfaces, credentials.ssh_key_name, user_data base64, volumes (virtual)}} → {tasks}; `GET /cloud/v1/tasks/{id}` state NEW/RUNNING/FINISHED/ERROR, created_resources.ai_clusters.
- Quota: `/cloud/v2/client_quotas` → regional baremetal_gpu_h100_count_limit/usage (servers).
- Auth `Authorization: APIKey <token>`. No published rate limit.
