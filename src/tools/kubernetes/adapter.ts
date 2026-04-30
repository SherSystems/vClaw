// Backwards-compatible alias for the provider-owned Kubernetes adapter.
import { KubernetesAdapter as ProviderKubernetesAdapter } from "../../providers/kubernetes/adapter.js";

export const KubernetesAdapter = ProviderKubernetesAdapter;
export type { KubernetesAdapterConfig } from "../../providers/kubernetes/adapter.js";
