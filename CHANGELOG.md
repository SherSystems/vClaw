# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.3] - 2026-05-13

### Added

- **SSH per-target tier overrides + audit-trail emission** (`swarm4/ssh-polish`). `SshTarget.tier_overrides` accepts `default` (a floor that bumps low-risk commands up) and `commands` (a per-tag/per-command map that can raise OR lower the classifier verdict). `never` is never overridable. The classification result carries `base_tier` + `override` keys so audit logs can show what fired. Adapter emits an `SshExec` AgentEvent on every invocation.
- **Sudo-fallback ladder for SSH** (`feature/ssh-sudo-ladder`). New `runSshCommandWithSudoFallback` retries with `sudo -n <cmd>` when the original invocation fails with a permission-denied / operation-not-permitted / must-be-root / sudo-needs-password pattern AND the leading verb is in the target's `sudo_allowlist`. If the sudo'd version classifies as a higher tier than the unprivileged form, the ladder REFUSES the retry and returns `requiresApproval: true` — the caller's governance approval was for the lower tier only. Classifier now strips one leading `sudo` / `sudo -n` so allowlisted reads stay at the read tier. New `ufw allow|deny|delete|reload|enable|disable` rule (risky_write).
- **`SshSudoPolicy` config schema** — per-target NOPASSWD verb allowlist threaded from env-file JSON through `SshTargetSchema` to the adapter normalizer.
- **Snapshot retention floor** in the Proxmox storage-pause playbook (`feature/snapshot-retention`). `filterDeletableCandidates` excludes the newest non-`current` snapshot; with only one snapshot in scope, the plan is empty. Entries without `created_at` are treated as oldest for safety. Opt-in via `apply_retention_floor` so the thin-pool monitor's pure-observation mode is unchanged.
- **Pre-remediation safety snapshot.** `buildRemediationPlan` now prepends a `qm snapshot <vmid> rhodes-safety-<ISO>` step (Tier 2 safe_write) before any delete and appends a cleanup step for the *previous* `rhodes-safety-*` snap. Cleanup runs ONLY after a successful resume + verify; on failed resume, the prior safety snap is preserved. `validateRemediationCandidate` hard-rules deletion of `rhodes-safety-*` snaps unless invoked via the exact-name cleanup path. New executor method `qmTakeSnapshot(node, vmid, name, description?)`. New `RemediationStepKind` discriminator on plan steps.
- **In-VM diagnostic playbook** (`src/playbooks/vm-diagnostic.ts`, `feature/vm-diagnostic-playbook`). Pure decision module + `VmDiagnosticExecutor` interface mirroring the storage-pause architecture. Gather phase runs nine commands in parallel over SSH (`df -h`, `free -h`, `uptime`, `systemctl --failed`, `journalctl --since=10min -p err` system-wide + per-unit, `dmesg -T --level=err,crit,alert,emerg`, `ss -tlnp`, `systemctl status <service>`). Nine deterministic parsers reduce outputs to typed structs. Classifier produces a priority-ordered set of ten failure modes: `IO_ERROR > DISK_FULL > MEMORY_OOM > BOOT_LOOP > SERVICE_CRASHED > SERVICE_NOT_LISTENING > KERNEL_ERROR > DISK_PRESSURE > MEMORY_PRESSURE > UNDETERMINED`. Planner emits tier-classified remediation steps per mode (`journalctl --vacuum-size=500M`, `apt-get clean`, `systemctl restart`, etc.) with explicit operator-only escalations for BOOT_LOOP, KERNEL_ERROR, and DISK_FULL on `/` or unknown mounts. IO_ERROR signals are reported to the caller for cross-playbook handoff to storage-pause rather than auto-executed. End-to-end runner re-probes the app between steps and stops early on recovery.

### Fixed

- Classifier-leading-sudo regression — `sudo -n df` previously fell through to the fail-closed destructive default because the read rules anchor at start-of-string. Strip is bounded to one level so `sudo sudo rm -rf /` still classifies destructive.

### Notes

- Total tests: **2084 passing** (up from 1922 in v0.4.2). One pre-existing failure in `tests/frontends/dashboard-server-static.test.ts` (root-level static asset serving) reproduces on `main` prior to this release and is unrelated.
- No breaking API changes. `SshExecResult` shape is unchanged — the wider `SshExecWithEscalationResult` is returned by the new ladder function; `ssh_exec` adapter wrapping preserves backward compatibility.
- The vm-diagnostic playbook is registered in `src/playbooks/` but is not yet wired into `src/healing/playbooks.ts` as an auto-firing rule — operators can invoke it programmatically. Wiring into the healing orchestrator is queued for a follow-up so the service-http-probe → vm-diagnostic chain becomes automatic.

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
