// ============================================================
// vClaw — Privacy Router
// Redacts sensitive data before it reaches external LLM APIs.
// Inspired by NemoClaw's privacy isolation model.
// ============================================================

// ── Types ────────────────────────────────────────────────────

export interface RedactionResult {
  /** The sanitized text */
  text: string;
  /** Number of redactions applied */
  redaction_count: number;
  /** Categories of data that were redacted */
  categories: string[];
}

export interface PrivacyRouterOptions {
  /** Additional patterns to redact (regex → label) */
  customPatterns?: Array<{ pattern: RegExp; label: string }>;
  /** Fields to always fully redact in objects */
  sensitiveFields?: string[];
}

// ── Built-in Patterns ────────────────────────────────────────

interface RedactionPattern {
  pattern: RegExp;
  label: string;
  replacement: string;
}

const BUILT_IN_PATTERNS: RedactionPattern[] = [
  // API keys
  {
    pattern: /sk-ant-api03-[A-Za-z0-9_-]{20,}/g,
    label: "anthropic_api_key",
    replacement: "[REDACTED:anthropic_key]",
  },
  {
    pattern: /sk-[A-Za-z0-9_-]{20,}/g,
    label: "openai_api_key",
    replacement: "[REDACTED:api_key]",
  },

  // Proxmox API tokens (format: user@realm!tokenname=secret-uuid)
  {
    pattern: /PVEAPIToken=[^\s"']+/g,
    label: "proxmox_token",
    replacement: "PVEAPIToken=[REDACTED]",
  },
  {
    pattern: /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/g,
    label: "uuid_secret",
    replacement: "[REDACTED:uuid]",
  },

  // Telegram bot tokens (format: 123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11)
  // Must be before password_field so `token:` prefix doesn't match first
  {
    pattern: /\d{6,}:[A-Za-z0-9_-]{35,}/g,
    label: "telegram_token",
    replacement: "[REDACTED:telegram_token]",
  },

  // Passwords in common formats
  {
    pattern: /(?:password|passwd|pwd|secret|token|apikey|api_key)\s*[=:]\s*["']?[^\s"',}{)\[]+/gi,
    label: "password_field",
    replacement: "[REDACTED:credential]",
  },

  // Private IPv4 addresses (keep public ranges for general context)
  {
    pattern: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/g,
    label: "private_ip",
    replacement: "[REDACTED:ip]",
  },

  // SSH private keys
  {
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
    label: "ssh_private_key",
    replacement: "[REDACTED:private_key]",
  },

  // Bearer tokens
  {
    pattern: /Bearer\s+[A-Za-z0-9._~+/=-]+/g,
    label: "bearer_token",
    replacement: "Bearer [REDACTED]",
  },

  // Base64-encoded blobs that look like secrets (40+ chars)
  {
    pattern: /(?:secret|token|key|password)\s*[:=]\s*["']?[A-Za-z0-9+/]{40,}={0,2}["']?/gi,
    label: "base64_secret",
    replacement: "[REDACTED:encoded_secret]",
  },

  // VMware session tokens
  {
    pattern: /vmware-api-session-id:\s*[^\s"']+/gi,
    label: "vmware_session",
    replacement: "vmware-api-session-id: [REDACTED]",
  },
];

// Fields that should always be fully redacted when found in objects
const DEFAULT_SENSITIVE_FIELDS = [
  "password",
  "passwd",
  "secret",
  "tokenSecret",
  "token_secret",
  "apiKey",
  "api_key",
  "apikey",
  "private_key",
  "privateKey",
  "botToken",
  "bot_token",
  "authorization",
  "cookie",
  "session_id",
  "sessionId",
];

// ── Privacy Router ───────────────────────────────────────────

export class PrivacyRouter {
  private patterns: RedactionPattern[];
  private sensitiveFields: Set<string>;

  constructor(options: PrivacyRouterOptions = {}) {
    this.patterns = [...BUILT_IN_PATTERNS];
    if (options.customPatterns) {
      for (const { pattern, label } of options.customPatterns) {
        this.patterns.push({
          pattern,
          label,
          replacement: `[REDACTED:${label}]`,
        });
      }
    }

    this.sensitiveFields = new Set([
      ...DEFAULT_SENSITIVE_FIELDS,
      ...(options.sensitiveFields || []),
    ]);
  }

  /**
   * Redact sensitive data from a text string.
   */
  redactText(text: string): RedactionResult {
    let result = text;
    let count = 0;
    const categories: Set<string> = new Set();

    for (const { pattern, label, replacement } of this.patterns) {
      // Reset lastIndex for global regexps
      pattern.lastIndex = 0;
      const matches = result.match(pattern);
      if (matches) {
        count += matches.length;
        categories.add(label);
        result = result.replace(pattern, replacement);
      }
    }

    return {
      text: result,
      redaction_count: count,
      categories: [...categories],
    };
  }

  /**
   * Deep-redact sensitive fields from an object.
   * Returns a new object with sensitive values replaced.
   */
  redactObject<T>(obj: T): T {
    if (obj === null || obj === undefined) return obj;
    if (typeof obj === "string") return this.redactText(obj).text as unknown as T;
    if (typeof obj !== "object") return obj;

    if (Array.isArray(obj)) {
      return obj.map((item) => this.redactObject(item)) as unknown as T;
    }

    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (this.sensitiveFields.has(key.toLowerCase()) || this.sensitiveFields.has(key)) {
        result[key] = "[REDACTED]";
      } else if (typeof value === "string") {
        result[key] = this.redactText(value).text;
      } else if (typeof value === "object" && value !== null) {
        result[key] = this.redactObject(value);
      } else {
        result[key] = value;
      }
    }

    return result as T;
  }

  /**
   * Sanitize data specifically for LLM consumption.
   * Redacts the text and returns both sanitized output and a summary.
   */
  sanitizeForLLM(systemPrompt: string, userMessage: string): {
    system: string;
    user: string;
    redactions: { system: RedactionResult; user: RedactionResult };
  } {
    const systemResult = this.redactText(systemPrompt);
    const userResult = this.redactText(userMessage);

    return {
      system: systemResult.text,
      user: userResult.text,
      redactions: {
        system: systemResult,
        user: userResult,
      },
    };
  }

  /**
   * Mask a value for display (show first/last chars only).
   * Useful for logging — "sk-ant-...abc123"
   */
  static mask(value: string, visibleChars: number = 4): string {
    if (value.length <= visibleChars * 2) {
      return "*".repeat(value.length);
    }
    const start = value.slice(0, visibleChars);
    const end = value.slice(-visibleChars);
    return `${start}..${end}`;
  }
}
