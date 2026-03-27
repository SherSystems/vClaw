import { spawn } from "node:child_process";
import type {
  InfraAdapter,
  ToolDefinition,
  ToolCallResult,
  ClusterState,
} from "../types.js";

export class SystemAdapter implements InfraAdapter {
  name = "system";
  private _connected = false;

  async connect(): Promise<void> {
    this._connected = true;
  }

  async disconnect(): Promise<void> {
    this._connected = false;
  }

  isConnected(): boolean {
    return this._connected;
  }

  getTools(): ToolDefinition[] {
    return [
      {
        name: "ssh_exec",
        description:
          "Execute a command on a remote host via SSH. Use for post-deployment configuration, log retrieval, and service management.",
        tier: "risky_write",
        adapter: "system",
        params: [
          { name: "host", type: "string", required: true, description: "Target IP or hostname" },
          { name: "user", type: "string", required: false, description: "SSH user", default: "root" },
          { name: "command", type: "string", required: true, description: "Command to execute" },
          { name: "timeout_ms", type: "number", required: false, description: "Timeout in ms", default: 30000 },
        ],
        returns: "{ stdout, stderr, exitCode }",
      },
      {
        name: "local_exec",
        description:
          "Execute a command on the local machine. Use for local tool invocations or checks.",
        tier: "risky_write",
        adapter: "system",
        params: [
          { name: "command", type: "string", required: true, description: "Command to execute" },
          { name: "timeout_ms", type: "number", required: false, description: "Timeout in ms", default: 30000 },
        ],
        returns: "{ stdout, stderr, exitCode }",
      },
      {
        name: "ping",
        description: "Check if a host is reachable via ICMP ping.",
        tier: "read",
        adapter: "system",
        params: [
          { name: "host", type: "string", required: true, description: "Target IP or hostname" },
          { name: "count", type: "number", required: false, description: "Number of pings", default: 3 },
        ],
        returns: "{ reachable, latency_ms, packet_loss_pct }",
      },
      {
        name: "install_packages",
        description:
          "Install packages on a remote host via SSH. Automatically detects the package manager (apt, yum, dnf, apk) and runs the install. Use this after creating a VM to set up software.",
        tier: "risky_write",
        adapter: "system",
        params: [
          { name: "host", type: "string", required: true, description: "Target IP or hostname" },
          { name: "user", type: "string", required: false, description: "SSH user", default: "root" },
          { name: "packages", type: "string", required: true, description: "Space-separated list of packages to install (e.g. 'nginx docker.io curl')" },
          { name: "timeout_ms", type: "number", required: false, description: "Timeout in ms", default: 120000 },
        ],
        returns: "{ stdout, stderr, exitCode, packages_installed }",
      },
      {
        name: "configure_service",
        description:
          "Enable and start a systemd service on a remote host. Optionally write a config file before starting.",
        tier: "risky_write",
        adapter: "system",
        params: [
          { name: "host", type: "string", required: true, description: "Target IP or hostname" },
          { name: "user", type: "string", required: false, description: "SSH user", default: "root" },
          { name: "service", type: "string", required: true, description: "Service name (e.g. 'nginx', 'docker')" },
          { name: "config_path", type: "string", required: false, description: "Path to write a config file before starting" },
          { name: "config_content", type: "string", required: false, description: "Content to write to config_path" },
          { name: "action", type: "string", required: false, description: "Action: start, stop, restart, enable, status", default: "enable_and_start" },
          { name: "timeout_ms", type: "number", required: false, description: "Timeout in ms", default: 30000 },
        ],
        returns: "{ stdout, stderr, exitCode, service_status }",
      },
      {
        name: "run_script",
        description:
          "Upload and execute a multi-line shell script on a remote host via SSH. Use for complex provisioning that requires multiple commands.",
        tier: "risky_write",
        adapter: "system",
        params: [
          { name: "host", type: "string", required: true, description: "Target IP or hostname" },
          { name: "user", type: "string", required: false, description: "SSH user", default: "root" },
          { name: "script", type: "string", required: true, description: "Multi-line shell script to execute" },
          { name: "timeout_ms", type: "number", required: false, description: "Timeout in ms", default: 300000 },
        ],
        returns: "{ stdout, stderr, exitCode }",
      },
      {
        name: "wait_for_ssh",
        description:
          "Wait for SSH to become available on a host. Use after creating a VM to ensure it's ready for configuration. Polls every 5 seconds.",
        tier: "read",
        adapter: "system",
        params: [
          { name: "host", type: "string", required: true, description: "Target IP or hostname" },
          { name: "user", type: "string", required: false, description: "SSH user", default: "root" },
          { name: "max_wait_s", type: "number", required: false, description: "Maximum wait time in seconds", default: 120 },
        ],
        returns: "{ available, wait_time_s }",
      },
    ];
  }

  async execute(
    tool: string,
    params: Record<string, unknown>
  ): Promise<ToolCallResult> {
    const cleanParams = Object.fromEntries(
      Object.entries(params).filter(([k]) => !k.startsWith("_")),
    );
    switch (tool) {
      case "ssh_exec":
        return this.sshExec(cleanParams);
      case "local_exec":
        return this.localExec(cleanParams);
      case "ping":
        return this.ping(cleanParams);
      case "install_packages":
        return this.installPackages(cleanParams);
      case "configure_service":
        return this.configureService(cleanParams);
      case "run_script":
        return this.runScript(cleanParams);
      case "wait_for_ssh":
        return this.waitForSsh(cleanParams);
      default:
        return { success: false, error: `Unknown system tool: ${tool}` };
    }
  }

  async getClusterState(): Promise<ClusterState> {
    return {
      adapter: "system",
      nodes: [],
      vms: [],
      containers: [],
      storage: [],
      timestamp: new Date().toISOString(),
    };
  }

  private async sshExec(params: Record<string, unknown>): Promise<ToolCallResult> {
    const host = params.host as string;
    const user = (params.user as string) || "root";
    const command = params.command as string;
    const timeout = (params.timeout_ms as number) || 30000;

    if (!host || !command) {
      return { success: false, error: "host and command are required" };
    }

    return this.runProcess(
      "ssh",
      [
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        "-o", `ConnectTimeout=${Math.ceil(timeout / 1000)}`,
        "-o", "LogLevel=ERROR",
        `${user}@${host}`,
        command,
      ],
      timeout
    );
  }

  private async localExec(params: Record<string, unknown>): Promise<ToolCallResult> {
    const command = params.command as string;
    const timeout = (params.timeout_ms as number) || 30000;

    if (!command) {
      return { success: false, error: "command is required" };
    }

    return this.runProcess("bash", ["-c", command], timeout);
  }

  private async ping(params: Record<string, unknown>): Promise<ToolCallResult> {
    const host = params.host as string;
    const count = (params.count as number) || 3;

    if (!host) {
      return { success: false, error: "host is required" };
    }

    const result = await this.runProcess(
      "ping",
      ["-c", String(count), "-W", "2", host],
      10000
    );

    if (!result.success) {
      return {
        success: true,
        data: { reachable: false, latency_ms: null, packet_loss_pct: 100 },
      };
    }

    const output = (result.data as { stdout: string }).stdout;
    const lossMatch = output.match(/(\d+(?:\.\d+)?)% packet loss/);
    const latencyMatch = output.match(/rtt min\/avg\/max\/mdev = [\d.]+\/([\d.]+)/);

    return {
      success: true,
      data: {
        reachable: true,
        latency_ms: latencyMatch ? parseFloat(latencyMatch[1]) : null,
        packet_loss_pct: lossMatch ? parseFloat(lossMatch[1]) : 0,
      },
    };
  }

  private async installPackages(params: Record<string, unknown>): Promise<ToolCallResult> {
    const host = params.host as string;
    const user = (params.user as string) || "root";
    const packages = params.packages as string;
    const timeout = (params.timeout_ms as number) || 120000;

    if (!host || !packages) {
      return { success: false, error: "host and packages are required" };
    }

    const script = `
      if command -v apt-get >/dev/null 2>&1; then
        export DEBIAN_FRONTEND=noninteractive
        apt-get update -qq && apt-get install -y -qq ${packages}
      elif command -v dnf >/dev/null 2>&1; then
        dnf install -y ${packages}
      elif command -v yum >/dev/null 2>&1; then
        yum install -y ${packages}
      elif command -v apk >/dev/null 2>&1; then
        apk add ${packages}
      else
        echo "No supported package manager found" >&2
        exit 1
      fi
    `;

    const result = await this.runProcess(
      "ssh",
      [
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        "-o", "ConnectTimeout=10",
        "-o", "LogLevel=ERROR",
        `${user}@${host}`,
        script,
      ],
      timeout,
    );

    if (result.success) {
      return {
        success: true,
        data: {
          ...(result.data as Record<string, unknown>),
          packages_installed: packages.split(/\s+/).filter(Boolean),
        },
      };
    }
    return result;
  }

  private async configureService(params: Record<string, unknown>): Promise<ToolCallResult> {
    const host = params.host as string;
    const user = (params.user as string) || "root";
    const service = params.service as string;
    const configPath = params.config_path as string | undefined;
    const configContent = params.config_content as string | undefined;
    const action = (params.action as string) || "enable_and_start";
    const timeout = (params.timeout_ms as number) || 30000;

    if (!host || !service) {
      return { success: false, error: "host and service are required" };
    }

    let script = "";

    if (configPath && configContent) {
      const escaped = configContent.replace(/'/g, "'\\''");
      script += `mkdir -p "$(dirname '${configPath}')" && cat > '${configPath}' << 'VCLAW_EOF'\n${escaped}\nVCLAW_EOF\n`;
    }

    switch (action) {
      case "enable_and_start":
        script += `systemctl enable ${service} && systemctl start ${service} && systemctl status ${service} --no-pager`;
        break;
      case "start":
        script += `systemctl start ${service} && systemctl status ${service} --no-pager`;
        break;
      case "stop":
        script += `systemctl stop ${service}`;
        break;
      case "restart":
        script += `systemctl restart ${service} && systemctl status ${service} --no-pager`;
        break;
      case "enable":
        script += `systemctl enable ${service}`;
        break;
      case "status":
        script += `systemctl status ${service} --no-pager`;
        break;
      default:
        return { success: false, error: `Unknown action: ${action}` };
    }

    const result = await this.runProcess(
      "ssh",
      [
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        "-o", "ConnectTimeout=10",
        "-o", "LogLevel=ERROR",
        `${user}@${host}`,
        script,
      ],
      timeout,
    );

    if (result.success) {
      return {
        success: true,
        data: {
          ...(result.data as Record<string, unknown>),
          service_status: "active",
        },
      };
    }
    return result;
  }

  private async runScript(params: Record<string, unknown>): Promise<ToolCallResult> {
    const host = params.host as string;
    const user = (params.user as string) || "root";
    const script = params.script as string;
    const timeout = (params.timeout_ms as number) || 300000;

    if (!host || !script) {
      return { success: false, error: "host and script are required" };
    }

    return this.runProcess(
      "ssh",
      [
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        "-o", "ConnectTimeout=10",
        "-o", "LogLevel=ERROR",
        `${user}@${host}`,
        script,
      ],
      timeout,
    );
  }

  private async waitForSsh(params: Record<string, unknown>): Promise<ToolCallResult> {
    const host = params.host as string;
    const user = (params.user as string) || "root";
    const maxWait = (params.max_wait_s as number) || 120;

    if (!host) {
      return { success: false, error: "host is required" };
    }

    const start = Date.now();
    const deadline = start + maxWait * 1000;

    while (Date.now() < deadline) {
      const result = await this.runProcess(
        "ssh",
        [
          "-o", "StrictHostKeyChecking=no",
          "-o", "UserKnownHostsFile=/dev/null",
          "-o", "ConnectTimeout=5",
          "-o", "LogLevel=ERROR",
          "-o", "BatchMode=yes",
          `${user}@${host}`,
          "echo ok",
        ],
        10000,
      );

      if (result.success) {
        const waitTime = (Date.now() - start) / 1000;
        return {
          success: true,
          data: { available: true, wait_time_s: Math.round(waitTime * 10) / 10 },
        };
      }

      await new Promise((r) => setTimeout(r, 5000));
    }

    return {
      success: false,
      error: `SSH not available after ${maxWait}s`,
      data: { available: false, wait_time_s: maxWait },
    };
  }

  private runProcess(
    cmd: string,
    args: string[],
    timeout: number
  ): Promise<ToolCallResult> {
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let killed = false;

      const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });

      const timer = setTimeout(() => {
        killed = true;
        proc.kill("SIGTERM");
      }, timeout);

      proc.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        if (stdout.length > 10240) {
          stdout = stdout.slice(0, 10240) + "\n...[truncated]";
          proc.kill("SIGTERM");
        }
      });

      proc.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
        if (stderr.length > 5120) {
          stderr = stderr.slice(0, 5120) + "\n...[truncated]";
        }
      });

      proc.on("close", (code) => {
        clearTimeout(timer);
        if (killed) {
          resolve({
            success: false,
            error: `Command timed out after ${timeout}ms`,
            data: { stdout, stderr, exitCode: 124 },
          });
        } else {
          resolve({
            success: code === 0,
            data: { stdout, stderr, exitCode: code ?? 1 },
            error: code !== 0 ? `Exit code: ${code}` : undefined,
          });
        }
      });

      proc.on("error", (err) => {
        clearTimeout(timer);
        resolve({ success: false, error: err.message });
      });
    });
  }
}
