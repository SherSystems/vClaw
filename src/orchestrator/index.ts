// ============================================================
// RHODES — Orchestrator (v0.7 cluster upgrade) public exports
// ============================================================

export type {
  HostUpgradeProgress,
  HostUpgradeState,
  TransitionResult,
  UpgradeEvent,
  UpgradePhase,
  UpgradePlan,
  UpgradeRun,
} from "./types.js";

export {
  HOST_STATE_PROGRESSION,
  nextHostState,
  TERMINAL_PHASES,
} from "./types.js";

export type { CreatePlanInput } from "./store.js";

export { OrchestratorStore } from "./store.js";

export { transition } from "./state-machine.js";
