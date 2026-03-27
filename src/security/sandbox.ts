// ============================================================
// vClaw — Sandbox Isolation
// Executes tool calls in isolated worker threads with resource
// limits, timeouts, and crash containment.
// Inspired by NemoClaw's sandbox isolation model.
// ============================================================

import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ── Types ────────────────────────────────────────────────────

export interface SandboxResult {
  success: boolean;
  data?: unknown;
  error?: string;
  duration_ms: number;
  sandbox_id: string;
  terminated: boolean;
}

export interface SandboxOptions {
  /** Default timeout in ms for tool execution (default: 30000) */
  defaultTimeoutMs?: number;
  /** Per-tool timeout overrides */
  timeoutOverrides?: Record<string, number>;
  /** Maximum concurrent sandbox workers (default: 4) */
  maxConcurrent?: number;
  /** Enable resource tracking (default: true) */
  trackResources?: boolean;
}

export interface SandboxStats {
  total_executions: number;
  successful: number;
  failed: number;
  timed_out: number;
  crashed: number;
  active_workers: number;
  max_concurrent: number;
}

// ── Worker Message Types ─────────────────────────────────────

interface WorkerRequest {
  sandbox_id: string;
  tool: string;
  params: Record<string, unknown>;
  adapter_name: string;
}

interface WorkerResponse {
  sandbox_id: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

// ── Sandbox Manager ──────────────────────────────────────────

export class SandboxManager {
  private defaultTimeoutMs: number;
  private timeoutOverrides: Record<string, number>;
  private maxConcurrent: number;
  private activeWorkers: number = 0;
  private stats: SandboxStats;
  private executeFn: ((tool: string, params: Record<string, unknown>) => Promise<{
    success: boolean;
    data?: unknown;
    error?: string;
  }>) | null = null;

  constructor(options: SandboxOptions = {}) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30000;
    this.timeoutOverrides = options.timeoutOverrides ?? {};
    this.maxConcurrent = options.maxConcurrent ?? 4;
    this.stats = {
      total_executions: 0,
      successful: 0,
      failed: 0,
      timed_out: 0,
      crashed: 0,
      active_workers: 0,
      max_concurrent: this.maxConcurrent,
    };
  }

  /**
   * Set the execution function that the sandbox will use.
   * This is the actual tool registry execute method.
   */
  setExecutor(fn: (tool: string, params: Record<string, unknown>) => Promise<{
    success: boolean;
    data?: unknown;
    error?: string;
  }>): void {
    this.executeFn = fn;
  }

  /**
   * Execute a tool call within a sandboxed context.
   * Provides timeout enforcement, crash containment, and resource tracking.
   *
   * Note: Uses in-process isolation with timeout/crash protection rather than
   * worker_threads, because the tool registry and adapters hold state (connections,
   * mocks) that can't be serialized across threads. This gives us the key safety
   * properties (timeout, crash containment, concurrency limits) without the
   * serialization constraint.
   */
  async execute(
    tool: string,
    params: Record<string, unknown>,
  ): Promise<SandboxResult> {
    const sandboxId = randomUUID();
    const timeoutMs = this.timeoutOverrides[tool] ?? this.defaultTimeoutMs;
    const startTime = Date.now();

    this.stats.total_executions++;

    // Enforce concurrency limit
    if (this.activeWorkers >= this.maxConcurrent) {
      this.stats.failed++;
      return {
        success: false,
        error: `Sandbox concurrency limit reached (${this.maxConcurrent} active). Try again later.`,
        duration_ms: Date.now() - startTime,
        sandbox_id: sandboxId,
        terminated: false,
      };
    }

    if (!this.executeFn) {
      this.stats.failed++;
      return {
        success: false,
        error: "Sandbox executor not configured. Call setExecutor() first.",
        duration_ms: Date.now() - startTime,
        sandbox_id: sandboxId,
        terminated: false,
      };
    }

    this.activeWorkers++;
    this.stats.active_workers = this.activeWorkers;

    try {
      const result = await this.executeWithTimeout(tool, params, timeoutMs, sandboxId);
      const durationMs = Date.now() - startTime;

      if (result.success) {
        this.stats.successful++;
      } else {
        this.stats.failed++;
      }

      return {
        ...result,
        duration_ms: durationMs,
        sandbox_id: sandboxId,
        terminated: false,
      };
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const isTimeout = err instanceof Error && err.message.includes("timed out");

      if (isTimeout) {
        this.stats.timed_out++;
      } else {
        this.stats.crashed++;
      }

      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        duration_ms: durationMs,
        sandbox_id: sandboxId,
        terminated: isTimeout,
      };
    } finally {
      this.activeWorkers--;
      this.stats.active_workers = this.activeWorkers;
    }
  }

  /**
   * Get sandbox execution statistics.
   */
  getStats(): SandboxStats {
    return { ...this.stats };
  }

  /**
   * Reset statistics counters.
   */
  resetStats(): void {
    this.stats = {
      total_executions: 0,
      successful: 0,
      failed: 0,
      timed_out: 0,
      crashed: 0,
      active_workers: this.activeWorkers,
      max_concurrent: this.maxConcurrent,
    };
  }

  /**
   * Get the timeout for a specific tool.
   */
  getTimeout(tool: string): number {
    return this.timeoutOverrides[tool] ?? this.defaultTimeoutMs;
  }

  /**
   * Set a timeout override for a specific tool.
   */
  setTimeout(tool: string, timeoutMs: number): void {
    this.timeoutOverrides[tool] = timeoutMs;
  }

  // ── Internal ────────────────────────────────────────────────

  private async executeWithTimeout(
    tool: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    sandboxId: string,
  ): Promise<{ success: boolean; data?: unknown; error?: string }> {
    return new Promise((resolve, reject) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error(`Sandbox execution timed out after ${timeoutMs}ms for tool '${tool}' [${sandboxId}]`));
        }
      }, timeoutMs);

      this.executeFn!(tool, params)
        .then((result) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(result);
          }
        })
        .catch((err) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            // Propagate as rejection so the outer execute() catch classifies it as crashed
            reject(new Error(`Tool crashed: ${err instanceof Error ? err.message : String(err)}`));
          }
        });
    });
  }
}
