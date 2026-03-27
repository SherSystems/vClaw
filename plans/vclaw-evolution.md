# vClaw Evolution Plan

> **Objective:** Transform InfraWrap into vClaw — an open-source autonomous AI infrastructure agent that manages any infrastructure (VMware, Proxmox, future cloud providers) with NemoClaw-inspired security.

## Current State

| Project | Language | LOC | What it does |
|---------|----------|-----|-------------|
| **InfraWrap** | TypeScript | ~11.7K | Full agent loop, governance, healing, chaos, dashboard, telegram, MCP, CLI — Proxmox only |
| **vWrapper** | Python | ~1.2K | NLP → VMware commands via pyvmomi, basic guardrails |
| **homelab-mcp** | TypeScript | ~3K | 40 MCP tools for Proxmox, telegram bot, dashboard |

**Key insight:** InfraWrap already has `InfraAdapter` interface. Proxmox is the only implementation. We add VMware as a second adapter, bolt on security, and rebrand.

```
InfraAdapter (existing interface)
├── ProxmoxAdapter  ← exists
├── SystemAdapter   ← exists
├── VMwareAdapter   ← NEW (Step 2)
└── AWSAdapter      ← FUTURE
```

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                        vClaw                                │
├─────────────────────────────────────────────────────────────┤
│  Frontends:  CLI | Dashboard | Telegram | MCP Server        │
├─────────────────────────────────────────────────────────────┤
│  Agent Core: Planner → Executor → Observer → Replanner      │
├─────────────────────────────────────────────────────────────┤
│  Governance: Policy Engine | Approval Gates | Circuit Breaker│
│  Security:   Sandbox | Credential Vault | Privacy Router    │
├─────────────────────────────────────────────────────────────┤
│  Healing:    Anomaly Detection | Playbooks | Incidents      │
│  Chaos:      Scenarios | Blast Radius | Recovery Scoring    │
├─────────────────────────────────────────────────────────────┤
│  Provider Layer (InfraAdapter interface)                     │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐       │
│  │ Proxmox  │ │ VMware   │ │  AWS     │ │ K8s      │       │
│  │ Adapter  │ │ Adapter  │ │ Adapter  │ │ Adapter  │       │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘       │
└─────────────────────────────────────────────────────────────┘
```

---

## Step 1: Provider Abstraction Cleanup

**Goal:** Make InfraAdapter a proper multi-provider interface. Currently ProxmoxAdapter is tightly coupled in some places.

**Branch:** `feat/provider-abstraction`

### Context Brief
The `InfraAdapter` interface exists at `src/tools/proxmox/adapter.ts` but is defined alongside the Proxmox implementation. The `ToolRegistry` in `src/tools/registry.ts` manages adapters. Some agent code references Proxmox-specific concepts. This step decouples the interface and ensures the agent core is provider-agnostic.

### Tasks
- [ ] Extract `InfraAdapter` interface into `src/providers/interface.ts`
- [ ] Extract `ToolDefinition`, `ToolCallResult`, `ClusterState`, `VMInfo`, `NodeInfo`, `StorageInfo`, `ContainerInfo` into `src/providers/types.ts`
- [ ] Move ProxmoxAdapter to `src/providers/proxmox/adapter.ts`
- [ ] Move Proxmox client to `src/providers/proxmox/client.ts`
- [ ] Move SystemAdapter to `src/providers/system/adapter.ts`
- [ ] Update `ToolRegistry` to load providers from `src/providers/`
- [ ] Add `ProviderConfig` type to support multi-provider config:
  ```typescript
  interface ProviderConfig {
    type: "proxmox" | "vmware" | "aws";
    name: string;           // user-friendly name
    connection: Record<string, unknown>;
    enabled: boolean;
  }
  ```
- [ ] Update config.ts to support array of providers
- [ ] Grep all agent code for Proxmox-specific references and abstract them
- [ ] Update all imports across codebase
- [ ] Ensure all existing tests pass

### Verification
```bash
npm run build    # No type errors
npm test         # All existing tests pass
grep -r "proxmox" src/agent/ src/governance/ src/healing/ src/chaos/  # Should return 0 hits (all abstracted)
```

### Exit Criteria
- InfraAdapter interface is standalone in `src/providers/`
- Zero Proxmox-specific references in agent core, governance, healing, or chaos modules
- All tests green

### Rollback
Revert to previous commit. No external state changes.

---

## Step 2: VMware Provider (Port vWrapper)

**Goal:** Implement VMwareAdapter that speaks vSphere REST API, porting vWrapper's knowledge from Python to TypeScript.

**Branch:** `feat/vmware-provider`
**Depends on:** Step 1

### Context Brief
vWrapper uses `pyvmomi` (Python SOAP SDK) to talk to vCenter. For TypeScript, we'll use the **vSphere REST API** (available since vSphere 6.5, fully mature in 7.0+/8.0). This is cleaner than wrapping pyvmomi. The REST API covers VM lifecycle, host management, networking, storage, and sessions.

vSphere REST API base: `https://{vcenter}/api/`
Auth: Session-based (`POST /api/session` returns token) or Basic Auth per request.

### Tasks
- [ ] Create `src/providers/vmware/client.ts` — vSphere REST API client
  - Session management (create/refresh/destroy)
  - Self-signed cert support (lab environments)
  - Typed responses for all endpoints
- [ ] Create `src/providers/vmware/types.ts` — vSphere-specific types
  - VmSummary, HostSummary, DatastoreSummary, NetworkSummary
  - Map to generic ClusterState types
- [ ] Create `src/providers/vmware/adapter.ts` — VMwareAdapter implementing InfraAdapter
  - **Read tools:**
    - `list_vms` → `GET /api/vcenter/vm`
    - `get_vm_status` → `GET /api/vcenter/vm/{vm}`
    - `get_vm_config` → `GET /api/vcenter/vm/{vm}`
    - `list_nodes` (ESXi hosts) → `GET /api/vcenter/host`
    - `get_node_stats` → `GET /api/vcenter/host/{host}`
    - `list_storage` (datastores) → `GET /api/vcenter/datastore`
    - `list_networks` → `GET /api/vcenter/network`
    - `list_snapshots` → vSphere snapshot API
  - **Write tools:**
    - `start_vm` → `POST /api/vcenter/vm/{vm}/power?action=start`
    - `stop_vm` → `POST /api/vcenter/vm/{vm}/power?action=stop`
    - `create_vm` → `POST /api/vcenter/vm`
    - `create_snapshot` → vSphere snapshot API
    - `clone_vm` → vSphere clone API
  - **Destructive tools:**
    - `delete_vm` → `DELETE /api/vcenter/vm/{vm}`
    - `reboot_vm` → `POST /api/vcenter/vm/{vm}/power?action=reset`
  - `getClusterState()` → aggregate VMs, hosts, datastores into ClusterState
- [ ] Add VMware-specific env vars to config:
  ```
  VMWARE_HOST=vcenter.lab.local
  VMWARE_USER=administrator@vsphere.local
  VMWARE_PASSWORD=...
  VMWARE_INSECURE=true
  ```
- [ ] Add VMware tool tier classifications (matching Proxmox pattern)
- [ ] Write unit tests with mock vSphere API responses
- [ ] Write integration test that hits real vCenter (guarded by env var)
- [ ] Port vWrapper's insight/capacity reporting to VMware adapter

### Verification
```bash
npm run build
npm test
# Integration test (requires vCenter):
VMWARE_HOST=vcenter.lab.local VMWARE_USER=admin VMWARE_PASSWORD=xxx npm test -- --grep vmware
```

### Exit Criteria
- VMwareAdapter implements full InfraAdapter interface
- Can list VMs, create VMs, start/stop, snapshot against nested vCenter
- Governance tiers work identically to Proxmox
- Unit tests pass without vCenter, integration tests pass with vCenter

### Rollback
Remove `src/providers/vmware/` directory. No state changes.

---

## Step 3: Multi-Provider Agent Loop

**Goal:** Make the agent loop work across multiple providers simultaneously.

**Branch:** `feat/multi-provider`
**Depends on:** Step 2

### Context Brief
Currently the agent loop gets cluster state from a single provider. vClaw needs to manage VMs across both Proxmox AND VMware from a single goal. The planner needs to know which provider to target for each step.

### Tasks
- [ ] Update `ToolRegistry` to register tools with provider prefix:
  ```
  proxmox.list_vms, proxmox.create_vm
  vmware.list_vms, vmware.create_vm
  ```
- [ ] Update `ClusterState` to include provider source:
  ```typescript
  interface MultiClusterState {
    providers: { name: string; type: string; state: ClusterState }[];
    timestamp: string;
  }
  ```
- [ ] Update Planner system prompt to include provider context
- [ ] Update Executor to route `provider.tool` to correct adapter
- [ ] Update Observer to verify against correct provider's state
- [ ] Update HealingOrchestrator to monitor all connected providers
- [ ] Update ChaosEngine to target specific providers
- [ ] Update all frontends (CLI, Dashboard, Telegram, MCP) to show provider context
- [ ] Add provider selector to Dashboard UI (filter by provider)
- [ ] Tests: multi-provider plan generation, cross-provider state

### Verification
```bash
npm run build && npm test
# Manual: run CLI with both Proxmox and VMware configured, ask "list all VMs"
```

### Exit Criteria
- Agent can plan and execute across Proxmox + VMware in single goal
- Dashboard shows VMs from both providers with clear labels
- Healing monitors both providers

### Rollback
Revert branch. Agent falls back to single-provider mode.

---

## Step 4: Security Hardening (NemoClaw-Inspired)

**Goal:** Add sandbox isolation, credential vault, and privacy router.

**Branch:** `feat/security-hardening`
**Depends on:** Step 1 (parallel with Steps 2-3)

### Context Brief
NemoClaw's key security innovations: tool execution runs isolated from the agent process, credentials never touch the agent context, and sensitive data can be routed to local LLMs. We adapt these for infrastructure management.

### Tasks

#### 4A: Credential Vault
- [ ] Create `src/security/vault.ts`
  - Credentials stored encrypted at rest (AES-256-GCM)
  - Agent receives opaque credential references, never raw secrets
  - Providers resolve references at execution time
  - Audit log never contains credentials (scrubbing layer)
  - Support: env vars, files, or external vault (HashiCorp Vault API)
- [ ] Update all providers to use vault references instead of raw env vars
- [ ] Add `vault` CLI commands: `vclaw vault set`, `vclaw vault list`, `vclaw vault rotate`

#### 4B: Sandbox Isolation
- [ ] Create `src/security/sandbox.ts`
  - Tool execution runs in isolated subprocess (Node.js worker_threads or child_process)
  - Sandboxed process has: network access to infrastructure APIs only, no filesystem beyond /tmp
  - Timeout enforcement per tool execution
  - Resource limits (memory, CPU time)
- [ ] Governance engine gates sandbox entry (destructive tools always sandboxed)
- [ ] Sandbox violations logged to audit trail

#### 4C: Privacy Router
- [ ] Create `src/security/privacy-router.ts`
  - Classify data sensitivity: public, internal, confidential
  - Route LLM calls based on sensitivity:
    - Public → cloud LLM (Claude, GPT)
    - Internal → cloud LLM with PII scrubbing
    - Confidential → local LLM only (Ollama)
  - Infrastructure state (IPs, hostnames, configs) classified as "internal" by default
  - User queries classified as "public" by default
  - Configurable classification rules in policy YAML
- [ ] Add Ollama provider to LLM abstraction layer
- [ ] Add `privacy` section to policy YAML

#### 4D: Security Test Suite
- [ ] Create `tests/security/` directory
  - Prompt injection tests (malicious goals that try to bypass governance)
  - Credential leakage tests (verify secrets never appear in logs/LLM context)
  - Sandbox escape tests (verify isolation holds)
  - Privilege escalation tests (try to upgrade action tier)
  - Rate limiting tests

### Verification
```bash
npm test -- --grep security
# Manual: attempt prompt injection via CLI, verify blocked
# Manual: check audit logs for credential scrubbing
```

### Exit Criteria
- No raw credentials in agent context, logs, or LLM calls
- Destructive tools execute in sandbox
- Privacy router correctly classifies and routes
- Security test suite green with 0 bypass paths

### Rollback
Remove `src/security/`. Providers fall back to direct env var auth.

---

## Step 5: Rebrand & Package

**Goal:** Rename InfraWrap → vClaw, update all references, set up as installable package.

**Branch:** `feat/rebrand-vclaw`
**Depends on:** Steps 1-4

### Tasks
- [ ] Rename package: `infrawrap` → `vclaw` in package.json
- [ ] Update binary name: `infrawrap` → `vclaw`
- [ ] Update all user-facing strings (CLI prompts, dashboard title, telegram bot name)
- [ ] Update README.md with vClaw branding, architecture diagram, quickstart
- [ ] Create `vclaw.config.yaml` as unified config (replaces .env):
  ```yaml
  providers:
    - name: homelab-proxmox
      type: proxmox
      host: 192.168.1.100
      token_id: user@pam!token
      token_secret: xxx
    - name: homelab-vmware
      type: vmware
      host: vcenter.lab.local
      user: administrator@vsphere.local
      password: vault:vmware-admin  # vault reference

  security:
    vault:
      backend: local  # or hashicorp
    privacy:
      default_route: cloud
      local_llm: http://localhost:11434
    sandbox:
      enabled: true

  governance:
    mode: approve_risky
    guardrails:
      max_vms_per_action: 5
  ```
- [ ] Add `vclaw init` command (interactive setup wizard)
- [ ] Add `vclaw doctor` command (check connectivity to all providers)
- [ ] Docker image: `Dockerfile` for easy deployment
- [ ] GitHub Actions CI: lint, test, build, security scan
- [ ] LICENSE: Apache 2.0

### Verification
```bash
npm run build
vclaw doctor  # checks all provider connections
vclaw --version  # shows vclaw, not infrawrap
```

### Exit Criteria
- Zero references to "InfraWrap" in user-facing code
- `vclaw` binary works end-to-end
- Docker image builds and runs
- CI pipeline green

### Rollback
Git revert. Rename back.

---

## Step 6: Demo & Launch Prep

**Goal:** Create a killer demo for NVIDIA Inception, accelerator applications, and Hacker News.

**Branch:** `feat/demo-polish`
**Depends on:** Step 5

### Tasks
- [ ] Record terminal demo (asciinema or screen recording):
  1. `vclaw doctor` → shows Proxmox + VMware connected
  2. "Create a web server on VMware and a database on Proxmox" → multi-provider plan
  3. Show governance approval flow
  4. Run chaos scenario → watch self-healing kick in
  5. Show dashboard with both providers
- [ ] Landing page (simple, one-page):
  - Hero: "AI that runs your infrastructure"
  - Demo GIF/video
  - Feature bullets
  - GitHub link
  - "Backed by NVIDIA Inception" badge (once approved)
- [ ] GitHub repo polish:
  - Comprehensive README with architecture diagram
  - CONTRIBUTING.md
  - Issue templates
  - Example configs
  - Quickstart: 3 commands from zero to running
- [ ] Write HN launch post draft
- [ ] Prep NVIDIA Inception application (description of AI/GPU usage)
- [ ] Prep YC application draft (problem, solution, traction, founder-market fit)

### Verification
Demo runs end-to-end without errors on nested lab.

### Exit Criteria
- 2-minute demo video that shows the full loop
- Landing page deployed
- GitHub repo is public and polished
- Application drafts ready

### Rollback
N/A — content creation, no code risk.

---

## Dependency Graph

```
Step 1 (Provider Abstraction) ──┬──→ Step 2 (VMware Provider) ──→ Step 3 (Multi-Provider)
                                │                                         │
                                └──→ Step 4 (Security) ──────────────────┘
                                                                          │
                                                                          ▼
                                                              Step 5 (Rebrand)
                                                                          │
                                                                          ▼
                                                              Step 6 (Demo & Launch)
```

**Parallel opportunities:**
- Steps 2 and 4 can run in parallel (both depend only on Step 1)
- Step 4A (Vault) and 4B (Sandbox) can be developed in parallel

## Model Assignments

| Step | Model | Reason |
|------|-------|--------|
| 1 | Default (Sonnet) | Mechanical refactoring, well-defined moves |
| 2 | Strongest (Opus) | API design decisions, type mapping complexity |
| 3 | Strongest (Opus) | Multi-provider orchestration is architecturally complex |
| 4 | Strongest (Opus) | Security requires careful design |
| 5 | Default (Sonnet) | Mostly renaming and config work |
| 6 | Default (Sonnet) | Content creation and polish |

## Tech Stack Summary

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 20+ |
| Language | TypeScript 5.7 |
| AI SDK | @anthropic-ai/sdk, openai |
| MCP | @modelcontextprotocol/sdk |
| VMware API | vSphere REST API (native HTTPS) |
| Proxmox API | Proxmox VE REST API (native HTTPS) |
| Database | SQLite (better-sqlite3) for memory + audit |
| Dashboard | React 19 + Zustand + Vite |
| Telegram | grammy |
| Validation | Zod |
| Testing | Vitest |
| CI | GitHub Actions |
| Container | Docker |
| Security | AES-256-GCM (vault), worker_threads (sandbox) |
| Local LLM | Ollama (privacy router) |
