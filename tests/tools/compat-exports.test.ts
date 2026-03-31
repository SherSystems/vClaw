import { describe, expect, it } from "vitest";
import { ToolRegistry as LegacyToolRegistry } from "../../src/tools/registry.js";
import { ProxmoxAdapter as LegacyProxmoxAdapter } from "../../src/tools/proxmox/adapter.js";
import { ProxmoxClient as LegacyProxmoxClient } from "../../src/tools/proxmox/client.js";
import { SystemAdapter as LegacySystemAdapter } from "../../src/tools/system/tools.js";
import { ToolRegistry as ProviderToolRegistry } from "../../src/providers/registry.js";
import { ProxmoxAdapter as ProviderProxmoxAdapter } from "../../src/providers/proxmox/adapter.js";
import { ProxmoxClient as ProviderProxmoxClient } from "../../src/providers/proxmox/client.js";
import { SystemAdapter as ProviderSystemAdapter } from "../../src/providers/system/adapter.js";

describe("legacy tools compatibility exports", () => {
  it("re-exports ToolRegistry from providers", () => {
    expect(LegacyToolRegistry).toBe(ProviderToolRegistry);
  });

  it("re-exports Proxmox adapter and client contracts", () => {
    expect(LegacyProxmoxAdapter).toBe(ProviderProxmoxAdapter);
    expect(LegacyProxmoxClient).toBe(ProviderProxmoxClient);
  });

  it("re-exports SystemAdapter from providers", () => {
    expect(LegacySystemAdapter).toBe(ProviderSystemAdapter);
  });
});
