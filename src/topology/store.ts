// ============================================================
// Topology Store — SQLite persistence for application topology
// ============================================================

import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import { getDataDir } from '../config.js';
import type {
  Application,
  AppMember,
  AppDependency,
  AppTier,
  DiscoveredConnection,
  ImpactReport,
  TopologyGraph,
  TopologyNode,
  TopologyEdge,
  WorkloadType,
  LatencyRequirement,
} from './types.js';
import type { ProviderType } from '../providers/types.js';

// ── TopologyStore Class ────────────────────────────────────

export class TopologyStore {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const dataDir = getDataDir();
    mkdirSync(dataDir, { recursive: true });
    const path = dbPath ?? join(dataDir, 'topology.db');
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.createTables();
  }

  // ── CRUD: Applications ──────────────────────────────────

  createApp(
    name: string,
    tier: AppTier,
    owner?: string,
    description?: string,
    tags?: string[],
  ): Application {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO applications (id, name, tier, owner, description, tags, created_at, updated_at)
      VALUES (@id, @name, @tier, @owner, @description, @tags, @created_at, @updated_at)
    `).run({
      id,
      name,
      tier,
      owner: owner ?? null,
      description: description ?? null,
      tags: JSON.stringify(tags ?? []),
      created_at: now,
      updated_at: now,
    });

    return {
      id,
      name,
      tier,
      owner,
      description,
      tags: tags ?? [],
      members: [],
      dependencies: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  getApp(id: string): Application | null {
    const row = this.db.prepare('SELECT * FROM applications WHERE id = @id').get({ id }) as RawAppRow | undefined;
    if (!row) return null;
    return this.hydrateApp(row);
  }

  listApps(): Application[] {
    const rows = this.db.prepare('SELECT * FROM applications ORDER BY name').all() as RawAppRow[];
    return rows.map((row) => this.hydrateApp(row));
  }

  updateApp(
    id: string,
    updates: Partial<{ name: string; tier: AppTier; owner: string; description: string; tags: string[] }>,
  ): Application {
    const existing = this.getApp(id);
    if (!existing) throw new Error(`Application not found: ${id}`);

    const now = new Date().toISOString();
    const sets: string[] = ['updated_at = @updated_at'];
    const values: Record<string, unknown> = { id, updated_at: now };

    if (updates.name !== undefined) {
      sets.push('name = @name');
      values.name = updates.name;
    }
    if (updates.tier !== undefined) {
      sets.push('tier = @tier');
      values.tier = updates.tier;
    }
    if (updates.owner !== undefined) {
      sets.push('owner = @owner');
      values.owner = updates.owner;
    }
    if (updates.description !== undefined) {
      sets.push('description = @description');
      values.description = updates.description;
    }
    if (updates.tags !== undefined) {
      sets.push('tags = @tags');
      values.tags = JSON.stringify(updates.tags);
    }

    this.db.prepare(`UPDATE applications SET ${sets.join(', ')} WHERE id = @id`).run(values);

    return this.getApp(id)!;
  }

  deleteApp(id: string): void {
    const del = this.db.transaction(() => {
      this.db.prepare('DELETE FROM app_members WHERE app_id = @id').run({ id });
      this.db.prepare('DELETE FROM app_dependencies WHERE app_id = @id').run({ id });
      this.db.prepare('DELETE FROM applications WHERE id = @id').run({ id });
    });
    del();
  }

  // ── Members ─────────────────────────────────────────────

  addMember(appId: string, member: Omit<AppMember, 'id' | 'appId'>): AppMember {
    const id = crypto.randomUUID();

    this.db.prepare(`
      INSERT INTO app_members (id, app_id, workload_id, workload_type, provider, role, critical, name, ip_address)
      VALUES (@id, @app_id, @workload_id, @workload_type, @provider, @role, @critical, @name, @ip_address)
    `).run({
      id,
      app_id: appId,
      workload_id: member.workloadId,
      workload_type: member.workloadType,
      provider: member.provider,
      role: member.role,
      critical: member.critical ? 1 : 0,
      name: member.name ?? null,
      ip_address: member.ipAddress ?? null,
    });

    return { id, appId, ...member };
  }

  removeMember(appId: string, workloadId: string): void {
    this.db.prepare('DELETE FROM app_members WHERE app_id = @app_id AND workload_id = @workload_id').run({
      app_id: appId,
      workload_id: workloadId,
    });
  }

  getAppsForWorkload(workloadId: string): Application[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT a.* FROM applications a
      JOIN app_members m ON m.app_id = a.id
      WHERE m.workload_id = @workload_id
    `).all({ workload_id: workloadId }) as RawAppRow[];

    return rows.map((row) => this.hydrateApp(row));
  }

  // ── Dependencies ────────────────────────────────────────

  addDependency(appId: string, dep: Omit<AppDependency, 'id' | 'appId'>): AppDependency {
    const id = crypto.randomUUID();

    this.db.prepare(`
      INSERT INTO app_dependencies (id, app_id, from_workload, to_workload, port, protocol, service, latency_requirement, description)
      VALUES (@id, @app_id, @from_workload, @to_workload, @port, @protocol, @service, @latency_requirement, @description)
    `).run({
      id,
      app_id: appId,
      from_workload: dep.fromWorkloadId,
      to_workload: dep.toWorkloadId,
      port: dep.port,
      protocol: dep.protocol,
      service: dep.service,
      latency_requirement: dep.latencyRequirement,
      description: dep.description ?? null,
    });

    return { id, appId, ...dep };
  }

  removeDependency(appId: string, depId: string): void {
    this.db.prepare('DELETE FROM app_dependencies WHERE app_id = @app_id AND id = @id').run({
      app_id: appId,
      id: depId,
    });
  }

  getDependenciesForWorkload(workloadId: string): AppDependency[] {
    const rows = this.db.prepare(`
      SELECT * FROM app_dependencies
      WHERE from_workload = @workload_id OR to_workload = @workload_id
    `).all({ workload_id: workloadId }) as RawDepRow[];

    return rows.map(deserializeDep);
  }

  // ── Analysis ────────────────────────────────────────────

  getImpactReport(workloadId: string): ImpactReport {
    const apps = this.getAppsForWorkload(workloadId);

    // Resolve a display name for the target workload
    const memberRow = this.db.prepare(
      'SELECT name, workload_id FROM app_members WHERE workload_id = @wid LIMIT 1',
    ).get({ wid: workloadId }) as { name: string | null; workload_id: string } | undefined;

    const targetName = memberRow?.name ?? workloadId;

    const affectedApps = apps.map((app) => {
      const brokenDeps = app.dependencies.filter(
        (d) => d.fromWorkloadId === workloadId || d.toWorkloadId === workloadId,
      );

      const hasCriticalMember = app.members.some(
        (m) => m.workloadId === workloadId && m.critical,
      );

      let severity: 'critical' | 'warning' | 'info';
      if (hasCriticalMember || brokenDeps.length > 0) {
        severity = 'critical';
      } else if (app.members.some((m) => m.workloadId === workloadId)) {
        severity = 'warning';
      } else {
        severity = 'info';
      }

      return { app, brokenDependencies: brokenDeps, severity };
    });

    const totalBroken = affectedApps.reduce((sum, a) => sum + a.brokenDependencies.length, 0);

    return {
      targetWorkloadId: workloadId,
      targetName,
      affectedApps,
      totalAffectedApps: affectedApps.length,
      totalBrokenDependencies: totalBroken,
    };
  }

  getTopologyGraph(): TopologyGraph {
    const apps = this.listApps();
    const nodeMap = new Map<string, TopologyNode>();
    const edges: TopologyEdge[] = [];

    for (const app of apps) {
      for (const member of app.members) {
        const existing = nodeMap.get(member.workloadId);
        if (existing) {
          existing.appIds.push(app.id);
        } else {
          nodeMap.set(member.workloadId, {
            id: member.workloadId,
            name: member.name ?? member.workloadId,
            workloadType: member.workloadType,
            provider: member.provider,
            role: member.role,
            critical: member.critical,
            ipAddress: member.ipAddress,
            appIds: [app.id],
          });
        }
      }

      for (const dep of app.dependencies) {
        edges.push({
          id: dep.id,
          from: dep.fromWorkloadId,
          to: dep.toWorkloadId,
          port: dep.port,
          service: dep.service,
          protocol: dep.protocol,
          appId: app.id,
        });
      }
    }

    return {
      nodes: Array.from(nodeMap.values()),
      edges,
    };
  }

  // ── Discovery ───────────────────────────────────────────

  saveDiscoveredConnections(workloadId: string, connections: Omit<DiscoveredConnection, 'id'>[]): void {
    const stmt = this.db.prepare(`
      INSERT INTO discovered_connections
        (id, workload_id, local_addr, local_port, remote_addr, remote_port, state, process, discovered_at, resolved_remote_workload, resolved_service)
      VALUES
        (@id, @workload_id, @local_addr, @local_port, @remote_addr, @remote_port, @state, @process, @discovered_at, @resolved_remote_workload, @resolved_service)
    `);

    const insertAll = this.db.transaction((conns: Omit<DiscoveredConnection, 'id'>[]) => {
      for (const conn of conns) {
        stmt.run({
          id: crypto.randomUUID(),
          workload_id: workloadId,
          local_addr: conn.localAddr,
          local_port: conn.localPort,
          remote_addr: conn.remoteAddr,
          remote_port: conn.remotePort,
          state: conn.state,
          process: conn.process ?? null,
          discovered_at: conn.discoveredAt,
          resolved_remote_workload: conn.resolvedRemoteWorkloadId ?? null,
          resolved_service: conn.resolvedService ?? null,
        });
      }
    });

    insertAll(connections);
  }

  getDiscoveredConnections(workloadId: string): DiscoveredConnection[] {
    const rows = this.db.prepare(
      'SELECT * FROM discovered_connections WHERE workload_id = @workload_id ORDER BY discovered_at DESC',
    ).all({ workload_id: workloadId }) as RawConnectionRow[];

    return rows.map(deserializeConnection);
  }

  // ── Lifecycle ───────────────────────────────────────────

  close(): void {
    this.db.close();
  }

  // ── Private ─────────────────────────────────────────────

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS applications (
        id          TEXT PRIMARY KEY,
        name        TEXT UNIQUE NOT NULL,
        tier        TEXT NOT NULL,
        owner       TEXT,
        description TEXT,
        tags        TEXT,
        created_at  TEXT,
        updated_at  TEXT
      );

      CREATE TABLE IF NOT EXISTS app_members (
        id            TEXT PRIMARY KEY,
        app_id        TEXT NOT NULL REFERENCES applications(id),
        workload_id   TEXT NOT NULL,
        workload_type TEXT NOT NULL,
        provider      TEXT NOT NULL,
        role          TEXT NOT NULL,
        critical      INTEGER DEFAULT 0,
        name          TEXT,
        ip_address    TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_app_members_app_id ON app_members(app_id);
      CREATE INDEX IF NOT EXISTS idx_app_members_workload_id ON app_members(workload_id);

      CREATE TABLE IF NOT EXISTS app_dependencies (
        id                  TEXT PRIMARY KEY,
        app_id              TEXT NOT NULL REFERENCES applications(id),
        from_workload       TEXT NOT NULL,
        to_workload         TEXT NOT NULL,
        port                INTEGER NOT NULL,
        protocol            TEXT DEFAULT 'tcp',
        service             TEXT NOT NULL,
        latency_requirement TEXT DEFAULT 'any',
        description         TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_app_deps_app_id ON app_dependencies(app_id);
      CREATE INDEX IF NOT EXISTS idx_app_deps_from ON app_dependencies(from_workload);
      CREATE INDEX IF NOT EXISTS idx_app_deps_to ON app_dependencies(to_workload);

      CREATE TABLE IF NOT EXISTS discovered_connections (
        id                       TEXT PRIMARY KEY,
        workload_id              TEXT NOT NULL,
        local_addr               TEXT,
        local_port               INTEGER,
        remote_addr              TEXT,
        remote_port              INTEGER,
        state                    TEXT,
        process                  TEXT,
        discovered_at            TEXT,
        resolved_remote_workload TEXT,
        resolved_service         TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_disc_conn_workload ON discovered_connections(workload_id);
    `);
  }

  private hydrateApp(row: RawAppRow): Application {
    const members = this.db.prepare('SELECT * FROM app_members WHERE app_id = @app_id').all({
      app_id: row.id,
    }) as RawMemberRow[];

    const deps = this.db.prepare('SELECT * FROM app_dependencies WHERE app_id = @app_id').all({
      app_id: row.id,
    }) as RawDepRow[];

    return {
      id: row.id,
      name: row.name,
      tier: row.tier as AppTier,
      owner: row.owner ?? undefined,
      description: row.description ?? undefined,
      tags: parseJsonOr(row.tags, []),
      members: members.map(deserializeMember),
      dependencies: deps.map(deserializeDep),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

// ── Raw Row Types ─────────────────────────────────────────

interface RawAppRow {
  id: string;
  name: string;
  tier: string;
  owner: string | null;
  description: string | null;
  tags: string | null;
  created_at: string;
  updated_at: string;
}

interface RawMemberRow {
  id: string;
  app_id: string;
  workload_id: string;
  workload_type: string;
  provider: string;
  role: string;
  critical: number;
  name: string | null;
  ip_address: string | null;
}

interface RawDepRow {
  id: string;
  app_id: string;
  from_workload: string;
  to_workload: string;
  port: number;
  protocol: string;
  service: string;
  latency_requirement: string;
  description: string | null;
}

interface RawConnectionRow {
  id: string;
  workload_id: string;
  local_addr: string | null;
  local_port: number | null;
  remote_addr: string | null;
  remote_port: number | null;
  state: string | null;
  process: string | null;
  discovered_at: string | null;
  resolved_remote_workload: string | null;
  resolved_service: string | null;
}

// ── Deserialization Helpers ───────────────────────────────

function parseJsonOr<T>(value: string | null | undefined, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    const parsed = JSON.parse(value) as T;
    if (parsed === null || parsed === undefined) return fallback;
    return parsed;
  } catch {
    return fallback;
  }
}

function deserializeMember(row: RawMemberRow): AppMember {
  return {
    id: row.id,
    appId: row.app_id,
    workloadId: row.workload_id,
    workloadType: row.workload_type as WorkloadType,
    provider: row.provider as ProviderType,
    role: row.role,
    critical: row.critical === 1,
    name: row.name ?? undefined,
    ipAddress: row.ip_address ?? undefined,
  };
}

function deserializeDep(row: RawDepRow): AppDependency {
  return {
    id: row.id,
    appId: row.app_id,
    fromWorkloadId: row.from_workload,
    toWorkloadId: row.to_workload,
    port: row.port,
    protocol: row.protocol,
    service: row.service,
    latencyRequirement: row.latency_requirement as LatencyRequirement,
    description: row.description ?? undefined,
  };
}

function deserializeConnection(row: RawConnectionRow): DiscoveredConnection {
  return {
    id: row.id,
    workloadId: row.workload_id,
    localAddr: row.local_addr ?? '',
    localPort: row.local_port ?? 0,
    remoteAddr: row.remote_addr ?? '',
    remotePort: row.remote_port ?? 0,
    state: row.state ?? '',
    process: row.process ?? undefined,
    discoveredAt: row.discovered_at ?? '',
    resolvedRemoteWorkloadId: row.resolved_remote_workload ?? undefined,
    resolvedService: row.resolved_service ?? undefined,
  };
}
