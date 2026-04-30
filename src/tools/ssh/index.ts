// Backwards-compatible alias for the provider-owned SSH adapter.
// Mirrors src/tools/system/tools.ts so consumers can import either path.
export { SshAdapter, sshTools } from "../../providers/ssh/index.js";
export type {
  SshAdapterOptions,
  SshClassification,
  SshExecRequest,
  SshExecResult,
  SshTarget,
} from "../../providers/ssh/index.js";
