# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-05-11

### Changed

- **Renamed to RHODES** — Reasoning, Hybrid Orchestration, Deployment & Execution System. Tagline: "Infrastructure, executed." The product, package, CLI binary, systemd unit, banner, prompt prefix, help layout, and product copy are all rebranded. Historical changelog entries below retain the legacy "vClaw" name for accuracy.
- **CLI invocation:** `rhodes` (with alias `rho`). The legacy `vclaw` command is retained as a temporary alias and prints a one-line deprecation notice on invocation.
- **Prompt prefix:** `rhodes@mission:~$`.
- **Welcome banner:** ASCII wordmark + subtitle "Reasoning, Hybrid Orchestration, Deployment & Execution System".
- **Help layout** now follows the brand bible's OPERATIONS / PROVIDERS / WORKSPACES structure.
- **Config files:** primary workspace config is now `.rhodes.yaml`; per-user env at `~/.rhodes/.env`. `.vclaw.yaml` and `~/.vclaw/.env` continue to work but emit a deprecation warning encouraging rename.
- **Environment variables** renamed `VCLAW_*` → `RHODES_*` (e.g. `RHODES_SSH_TARGETS_FILE`, `RHODES_VAULT_KEY`, `RHODES_SLO_P95_LATENCY_MS`). Legacy `VCLAW_*` names continue to work as fallbacks.
- **Systemd unit** renamed `vclaw.service` → `rhodes.service`.
- **Internal defaults** renamed: S3 prefix `vclaw-migration/` → `rhodes-migration/`; scratch dir `/tmp/vclaw-migration` → `/tmp/rhodes-migration`; default Azure resource group `vclaw-migrations` → `rhodes-migrations`; provisioning default username `vclaw` → `rhodes`; MCP server name `vclaw` → `rhodes`; MCP URI scheme `vclaw://` → `rhodes://`.
- **Voice update**: success/error messages aligned with the brand bible (direct, technical, calm).

### Notes

- Dashboards under `dashboard/` and `dashboard-v2/` are tracked for a separate rebrand pass and are not changed in this release. The embedded `src/frontends/dashboard/template.ts` retains a small number of legacy "vClaw" strings pending that follow-up. The static logo asset `vclaw-logo.png` is left in place to avoid breaking dashboard builds.
- No changes to provider tool surface, agent core behavior, governance, or migration semantics. This release is rebrand only.

## [0.2.4] - 2026-05-07

### Fixed

- **Planner now tolerates LLM responses wrapped in markdown fences.** Models frequently emit ```` ```json ... ``` ```` even when the prompt forbids them — the parser now strips fences (with or without language tag) and falls back to slicing the first `{` to last `}` if prose surrounds the JSON object. Previously this surfaced as `Failed to parse LLM plan response as JSON` and aborted the whole goal.
- 3 new tests covering `​```json` fences, bare `​```` fences, and prose-before-JSON cases.

### Notes

- Total tests: 1777 passing.

## [0.2.3] - 2026-05-07

### Added

- **Step-reference resolver** (`src/agent/step-references.ts`) — multi-step plans can now thread output between steps using `${step_X.field}` syntax. Supports nested paths, array indices (`${step_2.vms[0].id}`), whole-step references (`${step_3}`), and preserves native types when the entire param value is a single placeholder. Resolves at orchestration time, before each step's params hit the executor.
- 14 unit tests covering happy paths, deeply-nested resolution, replan IDs (`step_r1`), and every error path (unknown step, failed dependency, primitive descent, missing field) — error messages are deliberately verbose so the next replan can self-correct.
- Planner prompt updated with **hard rules** for the LLM:
  - Use `${step_X.field}` to chain outputs; do NOT invent placeholder IDs.
  - AWS instance IDs are `i-` + 17 hex chars; never construct `i-<name>`.
  - Omit `subnet_id` on `aws_launch_instance` to use the default VPC's first subnet.

### Fixed

- Multi-step plans that reference prior step outputs no longer fail with "Invalid id: '${step_1.instance_id}'". The literal placeholder string is now resolved to the actual prior-step value before the tool call fires.

### Notes

- Total tests: 1774 passing (+14 from the resolver suite).

## [0.2.2] - 2026-05-07

### Fixed

- **AWS `launch_instance` no longer fails on hallucinated subnet IDs.** When `subnet_id` is omitted, the AWS client now auto-discovers the default VPC's first subnet and uses it. The `aws_launch_instance` tool description was hardened so the planner stops emitting placeholders like `subnet-12345678`. Clear error message surfaced when no default VPC exists.
- **Replan no longer crashes with "Step depends on unknown step".** When the LLM emits a replan whose `depends_on` references step IDs from the previous plan revision, those stale references are now stripped before dependency-graph validation. Replan recovery actually works end-to-end.

### Notes

- Total tests: 1760 passing (+2 covering the AWS auto-discovery + no-default-VPC paths).

## [0.2.1] - 2026-05-07

### Added

- **Cost adapter** (`src/providers/cost/`) — service adapter exposing three new tools the planner calls automatically when a goal mentions cost, budget, or migration:
  - `estimate_vm_cost` — workload + provider → monthly $ with compute / storage / license breakdown
  - `estimate_migration_cost` — source/target spec → delta, one-time cost, payback period, and a recommendation string
  - `compare_providers` — same workload across AWS, Azure, Proxmox, vSphere, ranked cheapest → most expensive
- Pricing tables for AWS (T3/M5/C5/R5), Azure (B/Dsv3/Esv3), Proxmox (TCO baseline), vSphere (TCO + Broadcom per-vCPU license at $11.25/mo).
- `.env` discovery — `vclaw` now finds its config from `$VCLAW_ENV_FILE`, then `./.env`, then `~/.vclaw/.env`, then the install dir. Run `vclaw` from anywhere; it just works.
- Claude Code / Codex-style interactive banner — `▌ vClaw` headline in brand orange, tagline beneath, version + provider + tool counts, `cwd:` line.
- Brand-orange `›` prompt replaces the cyan `vclaw>` prompt.
- Curated formatters for `get_vm_config`, `get_vm_status`, and the three cost tools — replaces raw object dumps with two-line scannable summaries. Long planner reasoning blocks truncated to 160 chars with a `(/plan for full)` hint.
- 25 new unit tests for the cost adapter.

### Fixed

- Suppressed Node.js DEP0040 punycode deprecation warnings emitted by transitive deps — they were interleaving with readline input and corrupting slash commands.
- Old "InfraWrap" ASCII banner that had been left over from the upstream port now correctly reads "vClaw".

### Notes

- Total tests: 1758 passing (up from 1338 in 0.2.0).
- No breaking API changes. `vclaw cli` and `vclaw` (no args) both drop into the new banner.

## [0.2.0] - 2026-04-30

### Added

- Azure provider support using ARM SDK clients for Compute, Network, and Resources.
- Azure quickstart coverage in `docs/quickstart.md` (service principal bootstrap + required env vars).
- README setup examples now include Azure credentials and dashboard-v2 context.
- Proxmox -> Azure end-to-end execute path (`migrate_proxmox_to_azure`) with rollback cleanup for VM/disk/blob resources.
- Cloud uploader migration path that streams disk bytes over SSH through vClaw into AWS S3 / Azure page blobs (no `aws` / `az` CLI required on source hosts).

### Changed

- Dashboard server now serves the redesigned `dashboard-v2/dist` frontend by default.
- Dashboard screenshots in `docs/screenshots/topology.png` and `docs/screenshots/resources.png` were refreshed for dashboard-v2.
- Cross-provider migration coverage now includes executed Proxmox -> Azure runs plus AWS/VMware/Proxmox flows.
- AWS importer now prefers ImportSnapshot for raw-disk paths, registers AMIs with HVM/ENA/UEFI-preferred defaults, and keeps ImportImage fallback.
- Multipart upload tuning for migration artifacts (`queueSize=8`, `partSize=64 MiB`) improves large-disk ingest throughput.
- Agent reliability updates: planner schema validation (Zod) and executor retry/backoff/limit controls.
- Verified release test baseline at `1338 passed / 20 skipped` (`npm test -- --run` on 2026-04-19).

### Testing

- Added 65 AWS tests across `tests/providers/aws-adapter.test.ts` and `tests/providers/aws-client.test.ts`.
- Added 58 Azure tests across `tests/providers/azure-adapter.test.ts` and `tests/providers/azure-client.test.ts`.
- Added targeted migration tests: `tests/migration/cloud-uploader.test.ts`, `tests/migration/azure-workload-analyzer.test.ts`, `tests/migration/adapter-azure-routes.test.ts`, `tests/migration/aws-importer.test.ts`.
- Added dashboard migration-progress coverage in `tests/frontends/dashboard-v2-migration-progress.test.ts`.

### Fixed

- Fixed flaky monitoring date-window behavior in `tests/monitoring/run-telemetry.test.ts` by aligning timer control in test setup.
