// ============================================================
// vClaw — VMware vSphere 8.0 REST API Client
// Session-based auth client using native Node.js https module
// ============================================================

import https from "node:https";
import http from "node:http";

import type {
  VmSummary,
  VmInfo,
  HostSummary,
  HostInfo,
  DatastoreSummary,
  DatastoreInfo,
  NetworkSummary,
  ClusterSummary,
  ClusterInfo,
  ResourcePoolSummary,
  SnapshotSummary,
  GuestInfo,
  VmCreateSpec,
} from "./types.js";

// ── Config ──────────────────────────────────────────────────

export interface VSphereClientConfig {
  host: string;
  user: string;
  password: string;
  insecure?: boolean;
}

// ── Client ──────────────────────────────────────────────────

export class VSphereClient {
  private readonly host: string;
  private readonly user: string;
  private readonly password: string;
  private readonly insecure: boolean;
  private sessionToken: string | null = null;

  constructor(config: VSphereClientConfig) {
    this.host = config.host;
    this.user = config.user;
    this.password = config.password;
    this.insecure = config.insecure ?? true;
  }

  // ── Session Management ──────────────────────────────────

  async createSession(): Promise<string> {
    const token = await this.request<string>("POST", "/api/session", undefined, true);
    this.sessionToken = token;
    return token;
  }

  async deleteSession(): Promise<void> {
    if (this.sessionToken) {
      try {
        await this.request<void>("DELETE", "/api/session");
      } finally {
        this.sessionToken = null;
      }
    }
  }

  isConnected(): boolean {
    return this.sessionToken !== null;
  }

  // ── VMs ────────────────────────────────────────────────────

  async listVMs(filter?: Record<string, string>): Promise<VmSummary[]> {
    const query = filter ? this.buildQuery(filter) : "";
    const path = `/api/vcenter/vm${query}`;
    return this.request<VmSummary[]>("GET", path);
  }

  async getVM(vmId: string): Promise<VmInfo> {
    return this.request<VmInfo>("GET", `/api/vcenter/vm/${encodeURIComponent(vmId)}`);
  }

  async vmPowerOn(vmId: string): Promise<void> {
    await this.request<void>("POST", `/api/vcenter/vm/${encodeURIComponent(vmId)}/power?action=start`);
  }

  async vmPowerOff(vmId: string): Promise<void> {
    await this.request<void>("POST", `/api/vcenter/vm/${encodeURIComponent(vmId)}/power?action=stop`);
  }

  async vmReset(vmId: string): Promise<void> {
    await this.request<void>("POST", `/api/vcenter/vm/${encodeURIComponent(vmId)}/power?action=reset`);
  }

  async vmSuspend(vmId: string): Promise<void> {
    await this.request<void>("POST", `/api/vcenter/vm/${encodeURIComponent(vmId)}/power?action=suspend`);
  }

  // ── Hosts ──────────────────────────────────────────────────

  async listHosts(): Promise<HostSummary[]> {
    return this.request<HostSummary[]>("GET", "/api/vcenter/host");
  }

  async getHost(hostId: string): Promise<HostInfo> {
    return this.request<HostInfo>("GET", `/api/vcenter/host/${encodeURIComponent(hostId)}`);
  }

  // ── Datastores ─────────────────────────────────────────────

  async listDatastores(): Promise<DatastoreSummary[]> {
    return this.request<DatastoreSummary[]>("GET", "/api/vcenter/datastore");
  }

  async getDatastore(dsId: string): Promise<DatastoreInfo> {
    return this.request<DatastoreInfo>("GET", `/api/vcenter/datastore/${encodeURIComponent(dsId)}`);
  }

  // ── Networks ───────────────────────────────────────────────

  async listNetworks(): Promise<NetworkSummary[]> {
    return this.request<NetworkSummary[]>("GET", "/api/vcenter/network");
  }

  // ── Clusters ───────────────────────────────────────────────

  async listClusters(): Promise<ClusterSummary[]> {
    return this.request<ClusterSummary[]>("GET", "/api/vcenter/cluster");
  }

  async getCluster(clusterId: string): Promise<ClusterInfo> {
    return this.request<ClusterInfo>("GET", `/api/vcenter/cluster/${encodeURIComponent(clusterId)}`);
  }

  // ── Resource Pools ─────────────────────────────────────────

  async listResourcePools(): Promise<ResourcePoolSummary[]> {
    return this.request<ResourcePoolSummary[]>("GET", "/api/vcenter/resource-pool");
  }

  // ── Guest Info ─────────────────────────────────────────────

  async getVMGuest(vmId: string): Promise<GuestInfo> {
    return this.request<GuestInfo>("GET", `/api/vcenter/vm/${encodeURIComponent(vmId)}/guest/identity`);
  }

  // ── Snapshots ──────────────────────────────────────────────

  async listSnapshots(vmId: string): Promise<SnapshotSummary[]> {
    const result = await this.request<{ items: SnapshotSummary[] }>(
      "GET",
      `/api/vcenter/vm/${encodeURIComponent(vmId)}/snapshots`
    );
    return result.items ?? [];
  }

  async createSnapshot(
    vmId: string,
    name: string,
    description?: string,
    memory?: boolean
  ): Promise<string> {
    const body: Record<string, unknown> = { name };
    if (description !== undefined) body.description = description;
    if (memory !== undefined) body.memory = memory;
    return this.request<string>(
      "POST",
      `/api/vcenter/vm/${encodeURIComponent(vmId)}/snapshots`,
      body
    );
  }

  async deleteSnapshot(vmId: string, snapshotId: string): Promise<void> {
    await this.request<void>(
      "DELETE",
      `/api/vcenter/vm/${encodeURIComponent(vmId)}/snapshots/${encodeURIComponent(snapshotId)}`
    );
  }

  async revertSnapshot(vmId: string, snapshotId: string): Promise<void> {
    await this.request<void>(
      "POST",
      `/api/vcenter/vm/${encodeURIComponent(vmId)}/snapshots/${encodeURIComponent(snapshotId)}?action=revert`
    );
  }

  // ── VM CRUD ────────────────────────────────────────────────

  async createVM(spec: VmCreateSpec): Promise<string> {
    return this.request<string>("POST", "/api/vcenter/vm", { spec });
  }

  async deleteVM(vmId: string): Promise<void> {
    await this.request<void>("DELETE", `/api/vcenter/vm/${encodeURIComponent(vmId)}`);
  }

  // ── Private Helpers ────────────────────────────────────────

  private buildQuery(params: Record<string, string>): string {
    const entries = Object.entries(params).filter(
      ([, v]) => v !== undefined && v !== null && v !== ""
    );
    if (entries.length === 0) return "";
    const qs = new URLSearchParams(entries).toString();
    return `?${qs}`;
  }

  private request<T>(
    method: string,
    path: string,
    body?: unknown,
    isSessionCreate = false
  ): Promise<T> {
    return this.doRequest<T>(method, path, body, isSessionCreate, false);
  }

  private doRequest<T>(
    method: string,
    path: string,
    body: unknown | undefined,
    isSessionCreate: boolean,
    isRetry: boolean
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const headers: Record<string, string> = {
        Accept: "application/json",
      };

      if (isSessionCreate) {
        // Basic auth for session creation
        const encoded = Buffer.from(`${this.user}:${this.password}`).toString("base64");
        headers["Authorization"] = `Basic ${encoded}`;
      } else if (this.sessionToken) {
        headers["vmware-api-session-id"] = this.sessionToken;
      }

      let postData: string | undefined;
      if (body !== undefined && (method === "POST" || method === "PUT" || method === "PATCH")) {
        postData = JSON.stringify(body);
        headers["Content-Type"] = "application/json";
        headers["Content-Length"] = Buffer.byteLength(postData).toString();
      }

      const options: https.RequestOptions = {
        hostname: this.host,
        port: 443,
        path,
        method,
        headers,
        rejectUnauthorized: !this.insecure,
      };

      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on("end", () => {
          const statusCode = res.statusCode ?? 0;

          // Handle 401 with session refresh (retry once)
          if (statusCode === 401 && !isSessionCreate && !isRetry && this.sessionToken) {
            this.sessionToken = null;
            this.createSession()
              .then(() => this.doRequest<T>(method, path, body, false, true))
              .then(resolve)
              .catch(reject);
            return;
          }

          if (statusCode >= 200 && statusCode < 300) {
            if (!data || data.trim() === "") {
              resolve(undefined as unknown as T);
              return;
            }
            try {
              const parsed = JSON.parse(data);
              // vSphere REST API wraps responses in a "value" key
              if (parsed.value !== undefined) {
                resolve(parsed.value as T);
              } else {
                resolve(parsed as T);
              }
            } catch {
              resolve(data as unknown as T);
            }
          } else {
            let errorMsg = `vSphere API error: ${statusCode} ${res.statusMessage}`;
            try {
              const parsed = JSON.parse(data);
              if (parsed.value?.messages) {
                errorMsg += ` — ${JSON.stringify(parsed.value.messages)}`;
              } else if (parsed.value) {
                errorMsg += ` — ${JSON.stringify(parsed.value)}`;
              }
            } catch {
              if (data) {
                errorMsg += ` — ${data.slice(0, 500)}`;
              }
            }
            reject(new Error(errorMsg));
          }
        });
      });

      req.on("error", (err) => {
        reject(new Error(`vSphere request failed: ${err.message}`));
      });

      req.setTimeout(30_000, () => {
        req.destroy();
        reject(new Error(`vSphere request timed out: ${method} ${path}`));
      });

      if (postData) {
        req.write(postData);
      }
      req.end();
    });
  }
}
