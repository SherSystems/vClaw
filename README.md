<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/banner.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/banner.svg">
    <img alt="vClaw — Autonomous AI Infrastructure Agent" src="docs/assets/banner.svg" width="100%">
  </picture>
</p>

<p align="center">
  <strong>An autonomous AI agent that manages your entire infrastructure through natural language — with safety guardrails that prevent your AI from deleting production.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Node.js_22+-339933?logo=node.js&logoColor=white" alt="Node.js" />
  <img src="https://img.shields.io/badge/Anthropic_Claude-191919?logo=anthropic&logoColor=white" alt="Anthropic Claude" />
  <img src="https://img.shields.io/badge/Proxmox_VE-E57000?logo=proxmox&logoColor=white" alt="Proxmox" />
  <img src="https://img.shields.io/badge/VMware_vSphere-607078?logo=vmware&logoColor=white" alt="VMware" />
  <img src="https://img.shields.io/badge/907_Tests-passing-brightgreen" alt="Tests" />
  <img src="https://img.shields.io/badge/License-MIT-blue" alt="MIT License" />
</p>

<br/>

## The Problem

You manage infrastructure across **multiple platforms**: Proxmox for cost-effective compute, VMware for legacy workloads, maybe cloud for bursting. That means **multiple dashboards**, **multiple CLIs**, **multiple APIs**. Infrastructure is fragmented. Management is manual. Scaling is slow.

And you're doing it all wrong anyway — you should be describing *what* you want, not *how* to do it.

## The Solution

**vClaw** is an autonomous AI agent that understands your entire infrastructure and executes commands in natural language.

```bash
# Instead of this:
curl https://vcenter.local/api/vcenter/vm -X POST \
  -H "vmware-api-session-id: $SESSION" \
  -d '{"spec": {"name": "web-01", "cpu": {"cores": 4}, "memory": {"size_mib": 8192}}}' \

# You do this:
vclaw "Create a web server VM with 4 cores and 8GB RAM wherever has the most capacity"
```

vClaw will:
1. **Analyze** your multi-provider infrastructure (Proxmox + VMware + future providers)
2. **Plan** the best way to execute your request (which provider, which host, which resource pool)
3. **Execute** safely — with governance checks, human approval if needed, full audit trails
4. **Monitor** the result — detect failures, self-heal, chaos-test resilience
5. **Remember** — learn from what worked, avoid what failed

---

## Why vClaw is Different

| Feature | vClaw | Aria | Terraform | Ansible |
|---------|-------|------|-----------|---------|
| **Multi-hypervisor** | ✅ Proxmox + VMware | ❌ VMware only | ⚠️ Via providers | ⚠️ Via modules |
| **Autonomous execution** | ✅ Yes | ❌ Recommendations only | ❌ Code generation | ❌ Playbook-based |
| **Natural language** | ✅ First-class | ❌ No | ⚠️ AI copilot | ⚠️ AI copilot |
| **Safety governance** | ✅ 5-tier + approval gates | ✅ Enterprise | ⚠️ Policy engine | ⚠️ Manual |
| **Open source** | ✅ MIT | ❌ Proprietary | ✅ BSL | ✅ GPL |
| **Works on-prem** | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes |
| **Cost** | 🎉 Free | 💰💰💰 $$$K/year | 💰 Free/paid | 💰 Free/paid |

---

## Core Features

### 🧠 Autonomous Agent Loop
- **Plan**: LLM generates execution plans across all connected providers
- **Execute**: Steps run through 5-tier governance (read → safe_write → risky_write → destructive → never)
- **Observe**: Real-time monitoring detects failures immediately
- **Replan**: If something fails, agent investigates and adapts

### 🛡️ Enterprise Safety (NemoClaw-Inspired)

You don't just trust an AI with your infrastructure. vClaw is hardened:

- **Credential Vault**: Secrets encrypted with AES-256-GCM, never exposed to external APIs
- **Privacy Router**: Infrastructure data redacted before LLM calls — your topology stays yours
- **Sandboxed Execution**: Tools run in isolated contexts with timeout + crash containment
- **5-Tier Governance**: Actions classified by risk. Higher-risk ops require human approval
- **Circuit Breaker**: Stops after N consecutive failures to prevent cascading damage
- **Full Audit Trail**: Every action logged with before/after state, immutable SQLite backend

### 🔗 Multi-Provider Orchestration

- **Proxmox**: 30+ tools (VMs, nodes, snapshots, storage, firewall, migration)
- **VMware vSphere**: 18+ tools (VMs, hosts, datastores, snapshots, guest operations)
- **System**: SSH/local execution (install packages, run scripts, config management)
- **Pluggable**: Provider abstraction layer lets you add AWS, Azure, Kubernetes later

### 🚑 Self-Healing

Detects infrastructure anomalies and runs recovery playbooks automatically:
- VM crashes → instant restart
- Node down → workload migration
- Storage filling up → automatic cleanup
- Network latency spikes → automatic diagnostics

### 🔥 Chaos Engineering

Built-in fault injection for resilience testing:
- Kill random VMs and measure recovery time
- Stress-test CPU, memory, disk, network
- Trigger cascading failures to find weak points
- Generate before/after reports

### 📊 Real-Time Dashboard

React-based web UI showing:
- Live topology map (nodes, VMs, interconnects, metrics)
- Active plans and step-by-step execution
- Incident timeline and self-healing actions
- Resource utilization forecasting
- Governance audit trail

### 🎛️ Multiple Frontends

- **CLI**: Interactive terminal with command palette
- **Web Dashboard**: Real-time visualization + mobile-responsive
- **Claude Desktop**: MCP server integration — use vClaw inside Claude
- **Telegram** *(planned)*: Remote commands from your phone

---

## Quick Start

### Installation

```bash
# Clone the repo
git clone https://github.com/shersystems/vclaw.git
cd vclaw

# Install dependencies
npm install

# Create config
cp .env.example .env
```

### Configure Your Providers

**Proxmox:**
```bash
PROXMOX_HOST=192.168.1.10
PROXMOX_PORT=8006
PROXMOX_TOKEN_ID=root@pam!terraform
PROXMOX_TOKEN_SECRET=your-token-secret
PROXMOX_ALLOW_SELF_SIGNED=true
```

**VMware vSphere:**
```bash
VMWARE_HOST=vcenter.local
VMWARE_USER=administrator@vsphere.local
VMWARE_PASSWORD=your-password
VMWARE_INSECURE=true
```

**AI (pick one):**
```bash
AI_PROVIDER=anthropic
AI_API_KEY=sk-ant-...
AI_MODEL=claude-sonnet-4-20250514
```

### Run the Agent

```bash
# Interactive mode
npm run dev

# Tell it to do something
> Create a Ubuntu VM with 4 cores and 8GB RAM on the provider with most available memory
> List all VMs across Proxmox and VMware
> Migrate the "staging" VM from Proxmox to VMware
> Run chaos tests on the cluster and show me what breaks
```

### Run the Dashboard

```bash
npm run dashboard
# Open http://localhost:3000
```

### Use in Claude Desktop (MCP)

Add to your Claude Desktop config:

```json
{
  "mcpServers": {
    "vclaw": {
      "command": "node",
      "args": ["dist/src/frontends/mcp.js"]
    }
  }
}
```

Then in Claude: `@vclaw list all VMs across infrastructure`

---

## Architecture

```
vClaw Agent Core (14K+ LOC)
├── AI Planner       → Generates execution plans from natural language
├── Executor         → Runs steps through governance gates
├── Observer         → Detects failures & anomalies
├── Investigator     → Root cause analysis on failures
├── Memory           → Learns from past actions
├── Healing Engine   → Auto-remediation playbooks
└── Chaos Engine     → Fault injection & resilience testing

Provider Abstraction Layer (plugin system)
├── Proxmox Adapter  (30+ tools)
├── VMware Adapter   (18+ tools)
├── System Adapter   (SSH/local exec)
└── [Future: AWS, Azure, Kubernetes]

Security Layer (NemoClaw-inspired)
├── Credential Vault (AES-256-GCM)
├── Privacy Router   (redact before LLM)
├── Sandbox Manager  (timeout + isolation)
└── Audit Log        (immutable trail)

Governance Engine (5-tier safety)
├── Action Classifier (read/safe_write/risky_write/destructive/never)
├── Approval Gates   (human review for high-risk ops)
├── Circuit Breaker  (stop after N failures)
└── Audit Trail      (SQLite with WAL journaling)

Monitoring & Observability
├── Health Checks    (node status, VM state, storage)
├── Anomaly Detection (ML-based pattern detection)
├── Metric Store     (time-series data)
└── Event Stream     (real-time SSE to dashboard)

Frontends
├── CLI              (interactive terminal)
├── Web Dashboard    (React, mobile-responsive)
├── MCP Server       (Claude Desktop integration)
└── [Future: Telegram, Slack]
```

---

## Test Coverage

**907 tests** across:
- Agent core (planning, execution, observation, memory)
- Providers (Proxmox, VMware, System)
- Security (vault, privacy router, sandbox, audit)
- Governance (classifiers, approval gates, circuit breaker)
- Edge cases (163 tests for boundary conditions, null handling, error paths)

Run tests:
```bash
npm test              # Run all tests
npm run test:watch   # Watch mode
npm run test:coverage # Coverage report
```

---

## Roadmap

### Phase 1: Multi-Provider (Current)
- ✅ Proxmox provider
- ✅ VMware vSphere provider
- ✅ Multi-provider orchestration
- ✅ NemoClaw security model
- ✅ 907 passing tests

### Phase 2: Enterprise (Q2 2026)
- [ ] Kubernetes provider (EKS, AKS, GKE)
- [ ] AWS provider (EC2, RDS, ELB)
- [ ] Multi-tenant support (teams, RBAC)
- [ ] SSO/SAML authentication
- [ ] Compliance export (SOC2, ISO27001)

### Phase 3: Autonomous (Q3 2026)
- [ ] Self-evolving agents (learns new patterns)
- [ ] Predictive scaling (forecast workload needs)
- [ ] Cost optimization (automatic right-sizing)
- [ ] Disaster recovery as code (auto-tested failover)

### Phase 4: Ecosystem (Q4 2026)
- [ ] Marketplace for community adapters
- [ ] Terraform provider (manage vClaw via IaC)
- [ ] REST API (programmatic access)
- [ ] Mobile app (iOS/Android)

---

## Security & Privacy

vClaw is designed for enterprise environments:

- **Zero trust**: Every action verified, nothing assumed
- **Credential isolation**: Secrets never leave your network
- **Transparent LLM calls**: Redacted prompts, no infrastructure data to third parties
- **Audit immutability**: SQLite WAL ensures tamper-proof logs
- **Sandboxed execution**: Tool crashes can't cascade into agent failure
- **Governance by default**: High-risk operations require approval

See [SECURITY.md](docs/SECURITY.md) for detailed threat model and mitigations.

---

## Community & Contributing

vClaw is open source under MIT license. Contributions welcome:

- **Add a provider**: Implement the `InfraAdapter` interface (100 lines of code)
- **Improve governance**: Add new classifiers, policies, approval workflows
- **Bug reports**: Use GitHub Issues
- **Features**: Open a Discussion first

See [CONTRIBUTING.md](docs/CONTRIBUTING.md) for details.

---

## License

MIT. Use it anywhere, for anything, no restrictions.

---

## Credits

Built by [Pranav Patel](https://github.com/patelpa1639) at [Sher Systems](https://shersystems.com).

Inspired by:
- NVIDIA NemoClaw (security model)
- HashiCorp Terraform (provider abstraction)
- Kubernetes (operator pattern)
- Incident.io (playbook-based healing)

---

## Questions?

- **Docs**: [shersystems.com/docs](https://shersystems.com/docs)
- **GitHub Issues**: Report bugs here
- **Discussions**: Ask questions, share ideas
- **Twitter**: [@shersystems](https://twitter.com/shersystems)

---

<p align="center">
  <strong>Infrastructure management for the future.</strong><br/>
  <em>AI-powered, multi-provider, safety-first.</em>
</p>
