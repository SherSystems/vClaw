// ============================================================
// Topology Types — Application topology mapping
// Groups VMs and containers into applications with dependency tracking
// ============================================================

import type { ProviderType } from '../providers/types.js';

export type AppTier = 'production' | 'staging' | 'development' | 'test';
export type WorkloadType = 'vm' | 'container' | 'pod' | 'service';
export type LatencyRequirement = 'low' | 'medium' | 'any';

export interface Application {
  id: string;
  name: string;
  tier: AppTier;
  owner?: string;
  description?: string;
  tags: string[];
  members: AppMember[];
  dependencies: AppDependency[];
  createdAt: string;
  updatedAt: string;
}

export interface AppMember {
  id: string;
  appId: string;
  workloadId: string;
  workloadType: WorkloadType;
  provider: ProviderType;
  role: string;
  critical: boolean;
  name?: string;
  ipAddress?: string;
}

export interface AppDependency {
  id: string;
  appId: string;
  fromWorkloadId: string;
  toWorkloadId: string;
  port: number;
  protocol: string;
  service: string;
  latencyRequirement: LatencyRequirement;
  description?: string;
}

export interface DiscoveredConnection {
  id: string;
  workloadId: string;
  localAddr: string;
  localPort: number;
  remoteAddr: string;
  remotePort: number;
  state: string;
  process?: string;
  discoveredAt: string;
  resolvedRemoteWorkloadId?: string;
  resolvedService?: string;
}

export interface ImpactReport {
  targetWorkloadId: string;
  targetName: string;
  affectedApps: {
    app: Application;
    brokenDependencies: AppDependency[];
    severity: 'critical' | 'warning' | 'info';
  }[];
  totalAffectedApps: number;
  totalBrokenDependencies: number;
}

export interface TopologyGraph {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
}

export interface TopologyNode {
  id: string;
  name: string;
  workloadType: WorkloadType;
  provider: ProviderType;
  role: string;
  critical: boolean;
  status?: string;
  ipAddress?: string;
  appIds: string[];
}

export interface TopologyEdge {
  id: string;
  from: string;
  to: string;
  port: number;
  service: string;
  protocol: string;
  appId: string;
}
