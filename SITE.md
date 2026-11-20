# API Check — SITE.md

Slug: `apicheck`. Type: closed web application. Language: English (like API Balance). Live: https://apicheck.aaadub.workers.dev (deployed 20.11.2026). Repository: AAADUB/apicheck, Workers Builds on every push to `main`.

## Brief (Andrey, 20.11.2026)

A working site on Cloudflare behind a login, like API Balance, where he adds API keys and starts searches with parameters: notify by email when a machine of the chosen configuration is available (with its region), or search and create it at once. All needed parameters: polling frequency, exact configuration chosen in the interface from what the provider offers, region or any region, storage and so on. Study the APIs of Lambda, UpCloud, Nebius and RunPod in detail and expose their options; study similar services and their practices; look clear and professional. His need: one 8×H100 node for 23.11–13.12.2026 (inference, competition 3–6.12). He accepts RunPod's and Nebius's memory sizes.

## Decisions taken without asking

- English interface, the same sign-in scheme and look family as API Balance (Funnel fonts, a cool neutral palette with one green for "free now").
- Email only (no Telegram), from `apicheck@mail.miartech.co` (the sending subdomain already onboarded in his account).
- Address: the workers.dev subdomain; a custom domain later if wanted.
- A watch never stops or terminates machines.
- RunPod's own "deploy when available" queue is not used, so two mechanisms never start two machines.
- The first administrator is created through the first-run form with a one-time `SETUP_TOKEN` (his email address was not on record here), to be deleted after use.

## Research

Five parallel studies, notes in `docs/research/` (lambda.md, upcloud.md, nebius.md, runpod.md, practices.md). Key facts used: Lambda's `regions_with_capacity_available` and its 1 req/s and 1 launch/12 s limits; UpCloud's undocumented-in-legacy-docs `GET /1.3/device/availability` and 409 `SERVER_RESOURCES_UNAVAILABLE`; Nebius's capacity advisor and JWT exchange; RunPod REST v1 retired on 15.11.2026, v2 catalogue with `count`.
Practices adopted: separate "seen" from "launched"; write the launch before calling; stop on unclear answers; one loop per key sharing the rate limit; re-notify only after a gap; visible data freshness; availability history per hour of the week.

## Verification (20.11.2026)

| Check | Result |
|---|---|
| Worker tests (workerd): four adapters on documented shapes and error codes, Nebius JWT signature verified, API validation, engine seen/gone/notify-once, launch-once-then-finish, stop on quota, isolation between people, CSRF | 14/14 |
| Typecheck, build gate (English only, every error code has a message, no key-shaped strings) | clean |
| Playwright walk-through with the test provider: first run, key refused then added, notify watch, launch watch with a missing field then started, every screen at 360/390/768/1280/1440/1920 and dark | no overflow, no duplicate ids, no serious axe findings |
| Live providers | not tested: no keys yet. The first real check happens when Andrey adds a key. |

## Open

- Delete `SETUP_TOKEN` after the first administrator exists.
- First live test with each provider key; confirm UpCloud's `amount` meaning and price units, Nebius's capacity error path.

## Changelog

- 20.11.2026 — v1: four providers, watches with notify or launch, availability board, machines, activity, keys, users, settings; deployed.
