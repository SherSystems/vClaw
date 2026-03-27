// ============================================================
// vClaw — Security Module
// NemoClaw-inspired security features:
//   - Credential Vault (AES-256-GCM encrypted secret storage)
//   - Privacy Router (redact sensitive data before LLM calls)
//   - Sandbox Isolation (timeout + crash containment for tools)
// ============================================================

export { CredentialVault } from "./vault.js";
export type { EncryptedSecret, VaultEntry, VaultStore, VaultOptions } from "./vault.js";

export { PrivacyRouter } from "./privacy.js";
export type { RedactionResult, PrivacyRouterOptions } from "./privacy.js";

export { SandboxManager } from "./sandbox.js";
export type { SandboxResult, SandboxOptions, SandboxStats } from "./sandbox.js";
