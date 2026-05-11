// ============================================================
// RHODES — Step Reference Resolver
// ------------------------------------------------------------
// LLM planners naturally write things like
//   { instance_id: "${step_1.instance_id}" }
// expecting the agent to substitute the previous step's output.
// This module walks step params before execution and resolves
// those references against captured outputs from prior steps.
//
// Syntax supported:
//   ${step_1}                       → entire data of step_1
//   ${step_1.instance_id}           → data.instance_id
//   ${step_2.vms[0].id}             → data.vms[0].id
//   ${step_r1.subnets[0].subnet_id} → data.subnets[0].subnet_id
//
// If the entire string is a single ${...} placeholder, the value
// is returned with its native type (number, object, array, …).
// Otherwise the placeholder is interpolated into the surrounding
// string and the result is a string.
//
// Errors are deliberately verbose so that, when the next replan
// receives the failure message, the LLM can self-correct.
// ============================================================

export interface CapturedStepOutput {
  step_id: string;
  data: unknown;
  success: boolean;
  error?: string;
}

const PLACEHOLDER_RE = /\$\{([^}]+)\}/g;

/**
 * Walk a params object/array/string and resolve every ${step_X.path}
 * reference using the supplied previous outputs. Returns a deep-cloned
 * copy with substitutions applied. Throws a descriptive error when a
 * referenced step is missing, failed, or has no value at the requested
 * path.
 */
export function resolveStepReferences<T>(
  params: T,
  outputs: CapturedStepOutput[],
  contextStepId?: string,
): T {
  const ctx = contextStepId ? `step "${contextStepId}"` : "step";
  return walk(params, outputs, ctx) as T;
}

function walk(value: unknown, outputs: CapturedStepOutput[], ctx: string): unknown {
  if (typeof value === "string") {
    return resolveString(value, outputs, ctx);
  }
  if (Array.isArray(value)) {
    return value.map((v) => walk(v, outputs, ctx));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = walk(v, outputs, ctx);
    }
    return out;
  }
  return value;
}

function resolveString(
  s: string,
  outputs: CapturedStepOutput[],
  ctx: string,
): unknown {
  if (!s.includes("${")) return s;

  // Whole-string placeholder → return the value with its native type.
  const wholeMatch = /^\$\{([^}]+)\}$/.exec(s);
  if (wholeMatch) {
    return resolvePath(wholeMatch[1].trim(), outputs, ctx);
  }

  // Embedded — stringify substitutions inside surrounding text.
  return s.replace(PLACEHOLDER_RE, (_m, path: string) => {
    const value = resolvePath(path.trim(), outputs, ctx);
    if (value === null || value === undefined) return "";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  });
}

function resolvePath(
  path: string,
  outputs: CapturedStepOutput[],
  ctx: string,
): unknown {
  // Tokenize: "step_1.vms[0].id" → ["step_1", "vms", "0", "id"]
  const tokens = tokenize(path);
  if (tokens.length === 0) {
    throw new Error(
      `Empty step reference \${} in ${ctx}. Use a real path like \${step_1.instance_id}.`,
    );
  }

  const stepId = tokens[0];
  const output = outputs.find((o) => o.step_id === stepId);
  if (!output) {
    const known = outputs.map((o) => o.step_id).join(", ") || "(none yet)";
    throw new Error(
      `Step reference \${${path}} in ${ctx} points to unknown step "${stepId}". Known steps so far: ${known}. Use \${step_X.field} where step_X has already executed.`,
    );
  }
  if (!output.success) {
    throw new Error(
      `Step reference \${${path}} in ${ctx} points to step "${stepId}" which failed: ${output.error ?? "no error message"}. Cannot use its output. Replan with a different approach.`,
    );
  }

  // Walk the rest of the path into the data
  let current: unknown = output.data;
  for (let i = 1; i < tokens.length; i++) {
    const key = tokens[i];
    if (current === null || current === undefined) {
      throw new Error(
        `Step reference \${${path}} in ${ctx} hit null/undefined at token "${key}". Step "${stepId}" data: ${shortJson(output.data)}`,
      );
    }
    if (Array.isArray(current)) {
      const idx = Number(key);
      if (!Number.isInteger(idx)) {
        throw new Error(
          `Step reference \${${path}} in ${ctx} expected an array index at "${key}" but got "${key}". Use \${${stepId}[N].field}.`,
        );
      }
      current = current[idx];
    } else if (typeof current === "object") {
      current = (current as Record<string, unknown>)[key];
    } else {
      throw new Error(
        `Step reference \${${path}} in ${ctx} tried to descend into a primitive (${typeof current}) at "${key}".`,
      );
    }
  }

  if (current === undefined) {
    throw new Error(
      `Step reference \${${path}} in ${ctx} resolved to undefined. Step "${stepId}" data shape: ${shortJson(output.data)}`,
    );
  }
  return current;
}

function tokenize(path: string): string[] {
  // Split on . and [ ] together. "step_1.vms[0].id" → ["step_1", "vms", "0", "id"]
  return path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function shortJson(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    return s.length > 200 ? s.slice(0, 200) + "…" : s;
  } catch {
    return String(v);
  }
}
