// ============================================================
// RHODES — Proxmox Maintenance Tracker
//
// Proxmox has no native node-level "maintenance mode" API.
// We emulate one by persisting our own marker per node and letting
// operator-facing surfaces (dashboard, Slack) display it.
//
// Two implementations:
//   - FileMaintenanceTracker — atomic JSON file at
//     getDataDir()/proxmox-maintenance.json. Production default.
//   - InMemoryMaintenanceTracker — for tests; no disk I/O.
//
// Why a side store and not a Condition on the graph Resource? The
// primitives layer mustn't require the graph to be on (graph is env-
// gated OFF in v0.5.0 prod). A dedicated tiny store keeps the
// primitive self-contained. When graph discovery is on, the writer
// can populate an `InMaintenance` Condition from this tracker on
// each discovery pass — additive, not load-bearing.
// ============================================================

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getDataDir } from "../config.js";

export interface MaintenanceMeta {
  enteredAt: string; // ISO-8601
  reason?: string;
  planId?: string;
}

export interface MaintenanceTracker {
  markIn(node: string, meta?: Omit<MaintenanceMeta, "enteredAt">): Promise<MaintenanceMeta>;
  markOut(node: string): Promise<boolean>;
  isIn(node: string): boolean;
  metaFor(node: string): MaintenanceMeta | undefined;
  list(): { node: string; meta: MaintenanceMeta }[];
}

interface PersistedShape {
  version: 1;
  nodes: Record<string, MaintenanceMeta>;
}

/**
 * Fresh empty state. MUST be a factory — a module-level constant
 * would share its `nodes` object across every tracker instance and
 * mutations would silently bleed between unrelated state machines.
 * Caught while writing tests for v0.7.1.1.
 */
function emptyState(): PersistedShape {
  return { version: 1, nodes: {} };
}

/**
 * File-backed tracker with atomic write via tmp + rename. Tolerant
 * of missing/corrupt files (returns to empty on parse failure rather
 * than crashing — operators can inspect by hand).
 */
export class FileMaintenanceTracker implements MaintenanceTracker {
  private state: PersistedShape;

  constructor(private readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.state = this.load();
  }

  async markIn(
    node: string,
    meta?: Omit<MaintenanceMeta, "enteredAt">,
  ): Promise<MaintenanceMeta> {
    const full: MaintenanceMeta = {
      enteredAt: new Date().toISOString(),
      ...(meta ?? {}),
    };
    this.state.nodes[node] = full;
    this.persist();
    return full;
  }

  async markOut(node: string): Promise<boolean> {
    const had = Object.prototype.hasOwnProperty.call(this.state.nodes, node);
    if (had) {
      delete this.state.nodes[node];
      this.persist();
    }
    return had;
  }

  isIn(node: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.state.nodes, node);
  }

  metaFor(node: string): MaintenanceMeta | undefined {
    return this.state.nodes[node];
  }

  list(): { node: string; meta: MaintenanceMeta }[] {
    return Object.entries(this.state.nodes).map(([node, meta]) => ({ node, meta }));
  }

  private load(): PersistedShape {
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (
        parsed &&
        typeof parsed === "object" &&
        parsed.version === 1 &&
        parsed.nodes &&
        typeof parsed.nodes === "object"
      ) {
        return parsed as PersistedShape;
      }
      return emptyState();
    } catch {
      return emptyState();
    }
  }

  private persist(): void {
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), "utf8");
    renameSync(tmp, this.filePath);
  }
}

/** In-process tracker; used by tests. */
export class InMemoryMaintenanceTracker implements MaintenanceTracker {
  private state = new Map<string, MaintenanceMeta>();

  async markIn(
    node: string,
    meta?: Omit<MaintenanceMeta, "enteredAt">,
  ): Promise<MaintenanceMeta> {
    const full: MaintenanceMeta = {
      enteredAt: new Date().toISOString(),
      ...(meta ?? {}),
    };
    this.state.set(node, full);
    return full;
  }

  async markOut(node: string): Promise<boolean> {
    return this.state.delete(node);
  }

  isIn(node: string): boolean {
    return this.state.has(node);
  }

  metaFor(node: string): MaintenanceMeta | undefined {
    return this.state.get(node);
  }

  list(): { node: string; meta: MaintenanceMeta }[] {
    return [...this.state.entries()].map(([node, meta]) => ({ node, meta }));
  }
}

/** Default production tracker path. */
export function defaultMaintenanceTrackerPath(): string {
  return join(getDataDir(), "proxmox-maintenance.json");
}
