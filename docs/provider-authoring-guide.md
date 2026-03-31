# vClaw Provider Adapter Authoring Guide

This guide explains how to add a new infrastructure provider to vClaw using the current adapter contract in `src/providers/types.ts`.

## 1. Implement the `InfraAdapter` interface

Create a new adapter file under `src/providers/<provider>/adapter.ts` and implement:

- `name: string`
- `connect(): Promise<void>`
- `disconnect(): Promise<void>`
- `isConnected(): boolean`
- `getTools(): ToolDefinition[]`
- `execute(tool: string, params: Record<string, unknown>): Promise<ToolCallResult>`
- `getClusterState(): Promise<ClusterState>`

Use the existing adapters as references:

- `src/providers/proxmox/adapter.ts`
- `src/providers/vmware/adapter.ts`
- `src/providers/system/adapter.ts`

## 2. Define tools with the required schema

Each tool returned by `getTools()` must match `ToolDefinition`:

- `name`: globally unique tool name
- `description`: concise operator-facing description
- `tier`: one of `read | safe_write | risky_write | destructive | never`
- `adapter`: adapter name string (must match `this.name`)
- `params`: array of `{ name, type, required, description, default? }`
- `returns`: short string describing output shape

Recommended pattern (used in Proxmox/VMware adapters): local `tool()` and `param()` helper functions to keep definitions consistent.

## 3. Execute tools with safe error handling

Inside `execute()`, strip internal parameters and dispatch only known tools.

Recommended pattern:

1. Remove internal `_` keys from `params`.
2. Route with a `switch` in a private `dispatch(...)`.
3. Wrap dispatch in `try/catch`.
4. Return structured failures:
   - `{ success: false, error: "<message>" }`

Do not let adapter exceptions crash the orchestrator path.

## 4. Register your provider in startup

Update `src/index.ts`:

1. Import your adapter class.
2. Add config gating (only register when required credentials/config are present).
3. Call `registry.registerAdapter(new YourAdapter(...))`.

The `ToolRegistry` (`src/providers/registry.ts`) will automatically expose your tools to planning/execution once registered and connected.

## 5. Add configuration surface

Update:

- `.env.example` with provider-specific vars
- `src/config.ts` schema parsing and defaults
- `README.md` setup docs

Keep new secrets aligned with current credential handling patterns.

## 6. Testing patterns

Use Vitest and keep tests close to behavior:

- Adapter execution tests:
  - success paths for each high-value tool
  - invalid/missing parameter paths
  - upstream client error paths
- Registry integration tests:
  - adapter registration
  - tool routing to the correct adapter
  - disconnected adapter failure behavior
- Governance alignment checks:
  - ensure destructive operations are tagged `destructive`
  - ensure read-only operations are tagged `read`

Suggested locations:

- `tests/providers/<provider>-adapter.test.ts`
- `tests/providers/registry.test.ts` (or existing shared registry tests)

## 7. Security checklist for new providers

Before opening a PR, verify:

- Input validation:
  - Validate and normalize all tool inputs.
  - Reject malformed or out-of-range values early.
- Command execution safety:
  - Never interpolate raw user input into shell commands.
  - Prefer argument arrays over shell strings when possible.
- Credential handling:
  - Do not log secrets.
  - Keep credentials in config/vault paths only.
- Error boundaries:
  - Catch provider/client exceptions and return structured errors.
  - Include useful operator context, but avoid leaking secrets.
- Operational safeguards:
  - Use explicit timeouts for remote/API operations.
  - Keep retries bounded and idempotent-aware.

## 8. Final verification

Run before submitting:

```bash
npm run lint
npm test -- --run
npm run build
```

If your provider adds risky/destructive actions, include notes in the PR description about governance tier choices.
