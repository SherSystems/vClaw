# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - Unreleased

### Added

- Added `docs/provider-authoring-guide.md` with the current adapter contract, tool schema requirements, registration flow, and security checklist.
- Added `docs/quickstart.md` with Proxmox/VMware setup, optional vault migration flow, and governance-tier walkthrough.

### Changed

- Updated `CONTRIBUTING.md` with a dedicated `Security Contributions` section (input sanitization, error-path wrapping, and test requirements).
- Updated `README.md` with direct links to quickstart, provider authoring guide, and changelog.
- Re-verified current test status at release-note draft time: `907 passing` (`npm test -- --run` on 2026-03-30).

### Security

- Security hardening tracked in [SHE-4](/SHE/issues/SHE-4) is still in progress (not merged yet in this release draft), including:
  - system adapter command-injection hardening for package install paths
  - dashboard SSE JSON parsing guards
  - healing orchestrator dedup/timeout safeguards
  - audit log parse-fallback handling

### Testing

- Test-gap work tracked in [SHE-5](/SHE/issues/SHE-5) is still in progress (not merged yet in this release draft), including:
  - shell-injection regression tests for system adapter
  - dashboard SSE malformed-event resilience tests
  - healing orchestrator concurrency and timeout tests
  - audit corruption and autopilot error-path coverage

### Refactored

- Refactor follow-ups are tracked in [SHE-7](/SHE/issues/SHE-7); no merged refactor changes are included in this draft yet.

### Known Limitations

- Kubernetes adapter is not implemented yet.
- AWS adapter is not implemented yet.
- Security/test hardening in [SHE-4](/SHE/issues/SHE-4) and [SHE-5](/SHE/issues/SHE-5) is pending completion.
