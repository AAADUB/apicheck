# Hyperstack (NexGen Cloud) API — read 20.11.2026

Sources: https://docs.hyperstack.cloud/docs/api-reference/introduction, /rate-limits, /errors, /docs/hardware/flavors, /docs/hardware/gpu-stock-information,
and the models of the official SDK @nexgencloud/hyperstack-sdk-javascript 1.56.9-alpha (npm), which are generated from the OpenAPI spec.

- Base URL `https://infrahub-api.nexgencloud.com/v1`; the key goes in the `api_key` header, no prefix.
- Limit: 500 requests per minute per source IP, all endpoints together; 429 after that for the rest of the minute; no Retry-After documented.
- Errors: `{status: false, message, error_reason}`. 400 bad_request (example: "Insufficient balance to create the resource"), 400 compatibility_blocked,
  401 unauthorized, 403 forbidden, 404, 405, 406, 409 already_exist, 429, 500. **No documented code for "no capacity".**
- Availability:
  - `GET /core/flavors` → `{data: [{gpu, region_name, flavors: [{name, display_name, region_name, gpu, gpu_count, cpu, ram, disk, ephemeral, stock_available, ...}]}]}` (FlavorFields has `stock_available: Boolean`).
  - `GET /core/stocks` → `{stocks: [{region, "stock-type", models: [{model, available ("10+"), planned_7_days, planned_30_days, planned_100_days, configurations: {"1x","2x","4x","8x","10x"}}]}]}`; "real time", the public dashboard refreshes it at least every 30 s.
- Flavors with 8 GPUs (docs, 20.11.2026): n3-H100-SXM5x8 in CANADA-1 (192 vCPU, 1800 GB RAM, 32 TB ephemeral) and US-1 (192 vCPU, 960 GB RAM, 20 TB ephemeral);
  n3-H100x8 and n3-H100x8-NVLink (PCIe) in CANADA-1; n3-H200-SXM5x8, n3-B200-SXM6x8, n3-B300-SXM6x8 in CANADA-1.
- Launch: `POST /core/virtual-machines`, required `name, environment_name, flavor_name, key_name, count`; also `image_name, volume_name, assign_floating_ip,
  create_bootable_volume, user_data, callback_url, labels[], security_rules[{direction, ethertype, protocol, remote_ip_prefix, port_range_min, port_range_max}],
  enable_port_randomization, enhanced_monitoring_enabled, profile, flavor`. Response `{status, message, instances: [InstanceFields]}`.
- Environments (`GET /core/environments`, `{environments: [{name, region}]}`) belong to one region; SSH keys (`GET /core/keypairs`) belong to one environment.
  Images: `GET /core/images?region=` → `{images: [{region_name, type, images: [{name, region_name, ...}]}]}`.
- Find by name: `GET /core/virtual-machines?search=<name>&page=&pageSize=` → `{instances: [...]}`; also `GET /core/virtual-machines/name-availability/{name}`.
- Machine: `GET /core/virtual-machines/{id}`, `DELETE /core/virtual-machines/{id}`; InstanceFields: id, name, status, vm_state, power_state, floating_ip, fixed_ip, flavor, environment, labels.
- Price book: `GET /pricebook` → `[{name, value, original_value, discount_applied, start_time, end_time}]`. The docs do not say whether `value` is per GPU;
  API Check shows a price only when the name equals the flavor's GPU model, and multiplies by the GPU count (assumption, marked in the interface).
- Credit: `GET /billing/user-credit/credit` → `{data: {credit, threshold, can_create_instance}}`.

Assumptions to check with a real key: the exact text of a capacity refusal; whether flavor `gpu` names equal stock `model` names; whether a VM that cannot be placed is
refused at once or goes to ERROR (both are handled).
