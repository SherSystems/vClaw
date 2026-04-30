// ============================================================
// vClaw — Kubernetes Provider Types
// Trimmed shapes for the read-only resources the adapter exposes.
// ============================================================

export interface K8sNode {
  name: string;
  uid: string;
  status: "Ready" | "NotReady" | "Unknown";
  roles: string[];
  kubeletVersion: string;
  osImage: string;
  kernelVersion: string;
  containerRuntimeVersion: string;
  internalIP?: string;
  capacity: {
    cpu: string;
    memory: string;
    pods: string;
    storage?: string;
  };
  allocatable: {
    cpu: string;
    memory: string;
    pods: string;
    storage?: string;
  };
  creationTimestamp?: string;
  labels: Record<string, string>;
}

export interface K8sNamespace {
  name: string;
  uid: string;
  status: string;
  creationTimestamp?: string;
  labels: Record<string, string>;
}

export interface K8sPod {
  name: string;
  namespace: string;
  uid: string;
  phase: "Pending" | "Running" | "Succeeded" | "Failed" | "Unknown";
  nodeName?: string;
  podIP?: string;
  hostIP?: string;
  containers: K8sContainerStatus[];
  startTime?: string;
  creationTimestamp?: string;
  labels: Record<string, string>;
  restartCount: number;
}

export interface K8sContainerStatus {
  name: string;
  image: string;
  ready: boolean;
  restartCount: number;
  state: "running" | "waiting" | "terminated" | "unknown";
  reason?: string;
}

export interface K8sDeployment {
  name: string;
  namespace: string;
  uid: string;
  replicas: number;
  readyReplicas: number;
  availableReplicas: number;
  updatedReplicas: number;
  strategy: string;
  creationTimestamp?: string;
  labels: Record<string, string>;
  selector: Record<string, string>;
}

export interface K8sService {
  name: string;
  namespace: string;
  uid: string;
  type: string;
  clusterIP?: string;
  externalIPs: string[];
  ports: {
    name?: string;
    port: number;
    targetPort: number | string;
    protocol: string;
    nodePort?: number;
  }[];
  selector: Record<string, string>;
  creationTimestamp?: string;
  labels: Record<string, string>;
}
