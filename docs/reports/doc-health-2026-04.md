# vClaw Doc-Health Report (April 2026)

Audit date: 2026-04-18  
Auditor: Sher Technical Writer  
Scope: `README.md`, `docs/`, and source file header-comment coverage in `src/`

## Snapshot

- Markdown docs scanned: 11 (`README.md`, `CHANGELOG.md`, plus 9 files under `docs/` excluding assets/screenshots)
- TypeScript source files scanned for module-header coverage: 79
- Files with top-of-file module header comments: 64
- Files missing top-of-file module header comments: 15

## What Is Well-Documented

- Provider reference depth is strong for Azure, AWS, Proxmox, and VMware.
  - Each guide includes auth, tool-level references, parameters, and source-of-truth links.
- Quickstart quality is strong.
  - Covers setup for core providers, governance tiers, and first-run workflow.
- Contributor guidance exists and is actionable.
  - `docs/provider-authoring-guide.md` matches the current adapter contract and registration path.
- Architecture coverage is now present.
  - `docs/architecture.md` documents adapter pattern, governance, migration/topology/healing/chaos/dashboard, and extension flow.

## What Is Stale Or Risky

- Changelog is still called out as a draft in the main docs path.
  - `README.md` references `CHANGELOG.md` as including “0.2.0 draft release notes”, which can drift after release if not tightened.
- Header-comment coverage is inconsistent in key runtime modules.
  - 15 `src/` files do not have module headers, including high-change areas (`src/healing/*`, `src/config.ts`, `src/providers/registry.ts`, `src/index.ts`).

## What Is Missing

1. No migration reference guide despite 13 migration tools in `src/migration/adapter.ts`.
2. No topology reference guide despite 13 topology tools in `src/topology/adapter.ts`.
3. No system adapter guide despite 7 system tools in `src/providers/system/adapter.ts`.

These tools are first-class execution surfaces but are not documented to the same standard as provider guides.

## Top 3 Gaps To Fix Next

1. Create migration reference docs (`docs/migration.md`) for all `plan_migration_*`, `migrate_*`, and `analyze_workload` tools.
2. Create topology reference docs (`docs/topology.md`) for all `topology_*` tools and expected data model shapes.
3. Create system adapter reference docs (`docs/providers/system.md`) for `ssh_exec`, `local_exec`, `ping`, `install_packages`, `configure_service`, `run_script`, and `wait_for_ssh`.

## Follow-Up Issues

- Track in Paperclip:
  - [SHEA-16](/SHEA/issues/SHEA-16) — Migration reference docs
  - [SHEA-17](/SHEA/issues/SHEA-17) — Topology reference docs
  - [SHEA-18](/SHEA/issues/SHEA-18) — System adapter provider guide
