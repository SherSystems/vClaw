// Backwards-compatible alias for the provider-owned Kubernetes client.
import {
  KubernetesClient as ProviderKubernetesClient,
  KubernetesApiError as ProviderKubernetesApiError,
} from "../../providers/kubernetes/client.js";

export const KubernetesClient = ProviderKubernetesClient;
export const KubernetesApiError = ProviderKubernetesApiError;
export type { KubernetesClientConfig } from "../../providers/kubernetes/client.js";
export type {
  K8sNode,
  K8sNamespace,
  K8sPod,
  K8sContainerStatus,
  K8sDeployment,
  K8sService,
} from "../../providers/kubernetes/types.js";
