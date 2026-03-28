# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in vClaw, please report it responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, email us at: **security@shersystems.com**

We will acknowledge your report within 48 hours and provide a detailed response within 7 days, including next steps and timeline for a fix.

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |

## Security Model

vClaw is designed for managing production infrastructure. Security is not an afterthought.

### Credential Vault
- All secrets encrypted at rest with AES-256-GCM
- Unique IV per encryption operation
- Master key derived via scrypt (N=2^15, r=8, p=1)
- File permissions enforced at 0o600
- Credentials are never sent to external LLM APIs

### Privacy Router
- Infrastructure data (IPs, hostnames, topology) is redacted before any LLM API call
- Redaction is deterministic and reversible only within the agent process
- No telemetry or usage data is collected or transmitted

### Sandboxed Execution
- Each tool invocation runs in an isolated context
- Timeouts prevent runaway operations
- Crashes are contained and cannot cascade to the agent core

### 5-Tier Governance
- **Tier 0 (Read)**: No approval needed. View-only operations.
- **Tier 1 (Safe Write)**: No approval needed. Low-risk modifications (tagging, annotations).
- **Tier 2 (Risky Write)**: Approval required. Migrations, resizing, config changes.
- **Tier 3 (Destructive)**: Approval required. Deletions, snapshots, power operations.
- **Tier 4 (Never)**: Blocked. Formatting disks, destroying datastores. Cannot be overridden.

### Audit Trail
- Every action logged to an immutable SQLite database with WAL journaling
- Before/after state captured for all write operations
- Logs include timestamp, user, action, provider, risk tier, and approval status

## Best Practices for Deployment

1. Run vClaw behind a firewall or VPN. Do not expose the dashboard to the public internet.
2. Use API tokens with minimal required permissions for each provider.
3. Enable approval gates for Tier 2+ operations in production environments.
4. Regularly rotate credentials stored in the vault.
5. Review the audit trail periodically for unexpected operations.
