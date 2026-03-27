import { z } from "zod";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { CredentialVault } from "./security/vault.js";

dotenv.config();

const ProxmoxConfigSchema = z.object({
  host: z.string().default("localhost"),
  port: z.coerce.number().default(8006),
  tokenId: z.string().default(""),
  tokenSecret: z.string().default(""),
  allowSelfSignedCerts: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
});

const VMwareConfigSchema = z.object({
  host: z.string().default(""),
  user: z.string().default(""),
  password: z.string().default(""),
  insecure: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
});

const TelegramConfigSchema = z.object({
  botToken: z.string().default(""),
  allowedUsers: z
    .string()
    .default("")
    .transform((v) => (v ? v.split(",").map((s) => Number(s.trim())) : [])),
});

const AIConfigSchema = z.object({
  provider: z.enum(["anthropic", "openai"]).default("anthropic"),
  apiKey: z.string().default(""),
  model: z.string().default("claude-sonnet-4-20250514"),
});

const DashboardConfigSchema = z.object({
  port: z.coerce.number().default(3000),
});

const AutopilotConfigSchema = z.object({
  pollIntervalMs: z.coerce.number().default(30000),
  enabled: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

export const ConfigSchema = z.object({
  proxmox: ProxmoxConfigSchema,
  vmware: VMwareConfigSchema,
  telegram: TelegramConfigSchema,
  ai: AIConfigSchema,
  dashboard: DashboardConfigSchema,
  autopilot: AutopilotConfigSchema,
});

export type Config = z.infer<typeof ConfigSchema>;

let _config: Config | null = null;

export function getConfig(): Config {
  if (_config) return _config;

  _config = ConfigSchema.parse({
    proxmox: {
      host: process.env.PROXMOX_HOST,
      port: process.env.PROXMOX_PORT,
      tokenId: process.env.PROXMOX_TOKEN_ID,
      tokenSecret: process.env.PROXMOX_TOKEN_SECRET,
      allowSelfSignedCerts: process.env.PROXMOX_ALLOW_SELF_SIGNED,
    },
    vmware: {
      host: process.env.VMWARE_HOST,
      user: process.env.VMWARE_USER,
      password: process.env.VMWARE_PASSWORD,
      insecure: process.env.VMWARE_INSECURE,
    },
    telegram: {
      botToken: process.env.TELEGRAM_BOT_TOKEN,
      allowedUsers: process.env.TELEGRAM_ALLOWED_USERS,
    },
    ai: {
      provider: process.env.AI_PROVIDER,
      apiKey: process.env.AI_API_KEY,
      model: process.env.AI_MODEL,
    },
    dashboard: {
      port: process.env.DASHBOARD_PORT,
    },
    autopilot: {
      pollIntervalMs: process.env.AUTOPILOT_POLL_INTERVAL_MS,
      enabled: process.env.AUTOPILOT_ENABLED,
    },
  });

  return _config;
}

export function getProjectRoot(): string {
  const __filename = fileURLToPath(import.meta.url);
  return dirname(dirname(__filename));
}

export function getPoliciesDir(): string {
  return join(getProjectRoot(), "policies");
}

export function getDataDir(): string {
  const dir = join(getProjectRoot(), "data");
  return dir;
}

// ── Vault Integration (opt-in via VCLAW_VAULT_KEY) ──────────

let _vault: CredentialVault | null = null;

/**
 * Get or create the credential vault. Returns null if VCLAW_VAULT_KEY is not set.
 * The vault is stored at <dataDir>/vault.json.
 */
export function getOrCreateVault(): CredentialVault | null {
  const vaultKey = process.env.VCLAW_VAULT_KEY;
  if (!vaultKey) return null;

  if (_vault) return _vault;

  _vault = new CredentialVault({
    path: join(getDataDir(), "vault.json"),
    masterKey: vaultKey,
  });

  return _vault;
}

/**
 * Migrate config secrets into the vault.
 * Stores Proxmox token secret, VMware password, Telegram bot token, and AI API key.
 */
export function migrateToVault(config: Config, vault: CredentialVault): void {
  vault.importFromConfig({
    "proxmox.tokenSecret": {
      value: config.proxmox.tokenSecret,
      provider: "proxmox",
      field: "tokenSecret",
    },
    "vmware.password": {
      value: config.vmware.password,
      provider: "vmware",
      field: "password",
    },
    "telegram.botToken": {
      value: config.telegram.botToken,
      provider: "telegram",
      field: "botToken",
    },
    "ai.apiKey": {
      value: config.ai.apiKey,
      provider: "ai",
      field: "apiKey",
    },
  });
}
