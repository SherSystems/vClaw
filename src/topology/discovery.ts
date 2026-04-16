// ============================================================
// vClaw — SSH-Based Connection Discovery
// Scans VMs/containers via SSH to discover active network
// connections and map application dependencies automatically
// ============================================================

import type { SSHExecFn } from '../migration/types.js';
import type { DiscoveredConnection } from './types.js';
import type { VMInfo } from '../providers/types.js';
import { randomUUID } from 'crypto';

const WELL_KNOWN_PORTS: Record<number, string> = {
  22: 'ssh',
  25: 'smtp',
  53: 'dns',
  80: 'http',
  443: 'https',
  1433: 'mssql',
  1521: 'oracle',
  2379: 'etcd',
  3000: 'grafana',
  3306: 'mysql',
  4317: 'otel-grpc',
  5432: 'postgresql',
  5601: 'kibana',
  5672: 'rabbitmq',
  6379: 'redis',
  6443: 'k8s-api',
  7000: 'cassandra',
  8080: 'http-alt',
  8443: 'https-alt',
  8500: 'consul',
  8888: 'jupyter',
  9090: 'prometheus',
  9092: 'kafka',
  9200: 'elasticsearch',
  10250: 'kubelet',
  11211: 'memcached',
  15672: 'rabbitmq-mgmt',
  27017: 'mongodb',
};

export class ConnectionDiscovery {
  /**
   * SSH into a target host, run `ss -tnpa`, and parse the output
   * into DiscoveredConnection objects with resolved service names.
   */
  async discoverConnections(
    sshExec: SSHExecFn,
    host: string,
    user: string,
    vmIp?: string,
  ): Promise<DiscoveredConnection[]> {
    const result = await sshExec(host, user, 'ss -tnpa');
    const all = this.parseSsOutput(result.stdout);

    // Filter: keep only ESTAB connections that are not loopback-to-loopback
    const filtered = all.filter((c) => {
      if (c.state !== 'ESTAB') return false;
      if (c.localAddr === '127.0.0.1' && c.remoteAddr === '127.0.0.1') return false;
      return true;
    });

    // Set workloadId hint from the vmIp if provided
    for (const conn of filtered) {
      if (vmIp) {
        conn.workloadId = vmIp;
      }
      conn.resolvedService = this.inferService(conn.remotePort);
    }

    return filtered;
  }

  /**
   * Parse raw `ss -tnpa` output into DiscoveredConnection objects.
   *
   * Expected format:
   *   State  Recv-Q  Send-Q  Local Address:Port  Peer Address:Port  Process
   *   ESTAB  0       0       10.0.1.5:45032      10.0.1.10:5432     users:(("python3",pid=1234,fd=5))
   */
  parseSsOutput(output: string): DiscoveredConnection[] {
    const lines = output.trim().split('\n');
    const connections: DiscoveredConnection[] = [];

    // Skip the header line
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const parts = line.split(/\s+/);
      // Minimum: State, Recv-Q, Send-Q, LocalAddr:Port, PeerAddr:Port
      if (parts.length < 5) continue;

      const state = parts[0];
      const localAddrPort = parts[3];
      const remoteAddrPort = parts[4];

      const local = this.parseAddrPort(localAddrPort);
      const remote = this.parseAddrPort(remoteAddrPort);
      if (!local || !remote) continue;

      // Extract process name from users:(("name",pid=X,fd=Y)) if present
      let process: string | undefined;
      const remainder = parts.slice(5).join(' ');
      const processMatch = remainder.match(/users:\(\("([^"]+)"/);
      if (processMatch) {
        process = processMatch[1];
      }

      connections.push({
        id: randomUUID(),
        workloadId: '',
        localAddr: local.addr,
        localPort: local.port,
        remoteAddr: remote.addr,
        remotePort: remote.port,
        state,
        process,
        discoveredAt: new Date().toISOString(),
      });
    }

    return connections;
  }

  /**
   * Enrich connections by resolving remote IP addresses to known VM workload IDs.
   */
  resolveWorkloads(
    connections: DiscoveredConnection[],
    allVMs: VMInfo[],
  ): DiscoveredConnection[] {
    const ipToVm = new Map<string, VMInfo>();
    for (const vm of allVMs) {
      if (vm.ip_address) {
        ipToVm.set(vm.ip_address, vm);
      }
    }

    for (const conn of connections) {
      const vm = ipToVm.get(conn.remoteAddr);
      if (vm) {
        conn.resolvedRemoteWorkloadId = String(vm.id);
      }
    }

    return connections;
  }

  /**
   * Look up a port number in the well-known port map.
   * Returns the service name or `unknown-<port>` if not recognized.
   */
  inferService(port: number): string {
    return WELL_KNOWN_PORTS[port] ?? `unknown-${port}`;
  }

  /**
   * Group connections by remote address for aggregate analysis.
   * Useful for LLM-driven app grouping suggestions.
   */
  groupByRemote(
    connections: DiscoveredConnection[],
  ): Map<string, {
    remoteAddr: string;
    remoteWorkloadId?: string;
    services: Set<string>;
    connectionCount: number;
  }> {
    const groups = new Map<string, {
      remoteAddr: string;
      remoteWorkloadId?: string;
      services: Set<string>;
      connectionCount: number;
    }>();

    for (const conn of connections) {
      let group = groups.get(conn.remoteAddr);
      if (!group) {
        group = {
          remoteAddr: conn.remoteAddr,
          remoteWorkloadId: conn.resolvedRemoteWorkloadId,
          services: new Set(),
          connectionCount: 0,
        };
        groups.set(conn.remoteAddr, group);
      }

      group.connectionCount++;
      if (conn.resolvedService) {
        group.services.add(conn.resolvedService);
      }
      // Update workload ID if we get one later via resolveWorkloads
      if (conn.resolvedRemoteWorkloadId && !group.remoteWorkloadId) {
        group.remoteWorkloadId = conn.resolvedRemoteWorkloadId;
      }
    }

    return groups;
  }

  /**
   * Generate a human-readable summary of discovered connections
   * suitable for passing to the LLM agent for app grouping suggestions.
   */
  summarizeForLLM(connections: DiscoveredConnection[], vmName: string): string {
    const groups = this.groupByRemote(connections);

    if (groups.size === 0) {
      return `VM '${vmName}' has no active outbound connections.`;
    }

    const lines: string[] = [`VM '${vmName}' has the following active connections:`];

    for (const [, group] of groups) {
      const services = Array.from(group.services).join(', ');
      const ports = new Set<number>();
      for (const conn of connections) {
        if (conn.remoteAddr === group.remoteAddr) {
          ports.add(conn.remotePort);
        }
      }
      const portList = Array.from(ports).join(', ');
      const workloadHint = group.remoteWorkloadId
        ? ` [workload: ${group.remoteWorkloadId}]`
        : '';

      lines.push(
        `- ${group.connectionCount} connection${group.connectionCount !== 1 ? 's' : ''} to ${group.remoteAddr} (${services}, port ${portList})${workloadHint}`,
      );
    }

    return lines.join('\n');
  }

  // ── Private helpers ─────────────────────────────────────────

  private parseAddrPort(raw: string): { addr: string; port: number } | null {
    // Handle IPv6 bracket notation [::1]:port or IPv4 addr:port
    // Also handle *:port as wildcard
    const lastColon = raw.lastIndexOf(':');
    if (lastColon === -1) return null;

    const addr = raw.substring(0, lastColon);
    const port = parseInt(raw.substring(lastColon + 1), 10);
    if (isNaN(port)) return null;

    return { addr, port };
  }
}
