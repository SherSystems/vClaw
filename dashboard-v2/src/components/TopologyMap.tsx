import { useState, useCallback, type MouseEvent } from "react";
import { useStore } from "../store";
import { formatUptime } from "../hooks/useFormatters";
import type { VMInfo, NodeInfo, StorageInfo } from "../types";

interface TooltipState {
  visible: boolean;
  x: number;
  y: number;
  vm: VMInfo | null;
}

function vmStatusColor(status: string): string {
  switch (status) {
    case "running":
      return "var(--teal)";
    case "stopped":
      return "var(--red)";
    case "paused":
      return "var(--amber)";
    default:
      return "var(--text-tertiary)";
  }
}

function topoBarColor(pct: number): string {
  if (pct < 60) return "var(--teal)";
  if (pct < 80) return "var(--amber)";
  return "var(--red)";
}

function providerColor(type: string): string {
  switch (type) {
    case "vmware":
      return "#4B91E2";
    case "aws":
      return "#FF9900";
    case "azure":
      return "#2563EB";
    case "proxmox":
      return "#2DD4BF";
    default:
      return "var(--teal)";
  }
}

/** Map raw IP-based ESXi host names to friendly display names */
function friendlyNodeName(name: string): string {
  if (!name) return "unknown-node";
  // If it's an IP address, give it a friendly ESXi label
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name)) {
    const lastOctet = name.split(".").pop();
    return `esxi-${lastOctet}`;
  }
  return name;
}

/** Map datastore IDs like "datastore-14" to the name if available, otherwise clean up the ID */
function friendlyStorageName(id: string, type?: string): string {
  if (!id) return type ? `storage (${type})` : "storage";
  // If it's already a friendly name, keep it
  if (!id.startsWith("datastore-") && !id.startsWith("storage/")) return id;
  // Strip prefix for display
  if (id.startsWith("storage/")) return id.replace("storage/", "");
  return id;
}

function safeText(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

interface ProviderSectionProps {
  label: string;
  providerType: string;
  nodes: NodeInfo[];
  vms: VMInfo[];
  storage: StorageInfo[];
  yOffset: number;
  svgWidth: number;
  onVmEnter: (vm: VMInfo) => void;
  onVmMove: (e: MouseEvent) => void;
  onVmLeave: () => void;
}

function ProviderSection({
  label,
  providerType,
  nodes,
  vms,
  storage,
  yOffset,
  svgWidth,
  onVmEnter,
  onVmMove,
  onVmLeave,
}: ProviderSectionProps) {
  const accent = providerColor(providerType);
  const nodeBoxW = 220;
  const nodeBoxH = 80;
  const nodeSpacing = 40;
  const totalNodesW = nodes.length * nodeBoxW + Math.max(0, nodes.length - 1) * nodeSpacing;
  const nodesStartX = Math.max(20, (svgWidth - totalNodesW) / 2);

  const nodeY = yOffset + 30;

  const vmSectionY = nodeY + nodeBoxH + 60;
  const vmsPerRow = 7;
  const vmSpacingX = 100;
  const vmSpacingY = 100;
  const vmRows = Math.max(1, Math.ceil(vms.length / vmsPerRow));
  const vmSectionH = vmRows * vmSpacingY + 20;

  const storageSectionY = vmSectionY + vmSectionH + 30;
  const storageBoxW = 200;
  const storageBoxH = 60;
  const storageSpacing = 30;
  const totalStorageW = storage.length * storageBoxW + Math.max(0, storage.length - 1) * storageSpacing;
  const storageStartX = Math.max(20, (svgWidth - totalStorageW) / 2);

  const sectionHeight = storageSectionY + storageBoxH + 20 - yOffset;
  const sectionHasResources = nodes.length > 0 || vms.length > 0 || storage.length > 0;

  // Node center positions
  const nodeCenters: Record<string, { x: number; bottom: number }> = {};
  nodes.forEach((node, i) => {
    const x = nodesStartX + i * (nodeBoxW + nodeSpacing) + nodeBoxW / 2;
    const nodeKey = safeText(node.name, safeText(node.id, "unknown-node"));
    nodeCenters[nodeKey] = { x, bottom: nodeY + nodeBoxH };
  });

  // VM positions
  const vmPositions = vms.map((_, i) => {
    const row = Math.floor(i / vmsPerRow);
    const col = i % vmsPerRow;
    const rowCount = Math.min(vmsPerRow, vms.length - row * vmsPerRow);
    const rowW = rowCount * vmSpacingX;
    const rowStartX = (svgWidth - rowW) / 2 + vmSpacingX / 2;
    return {
      x: rowStartX + col * vmSpacingX,
      y: vmSectionY + 40 + row * vmSpacingY,
    };
  });

  return (
    <g>
      {/* Provider header */}
      <rect
        x={14}
        y={yOffset}
        width={svgWidth - 28}
        height={sectionHeight}
        rx={12}
        fill="none"
        stroke={accent}
        strokeWidth={1}
        strokeDasharray="4 4"
        opacity={0.25}
      />
      <rect
        x={20}
        y={yOffset - 10}
        width={label.length * 9 + 24}
        height={20}
        rx={4}
        fill="var(--bg-card)"
      />
      <circle cx={32} cy={yOffset} r={4} fill={accent} />
      <text
        x={42}
        y={yOffset + 4}
        fill={accent}
        fontSize={12}
        fontWeight={700}
        letterSpacing={1.5}
      >
        {label}
      </text>

      {!sectionHasResources && (
        <text x={30} y={nodeY + 24} fill="var(--text-tertiary)" fontSize={12}>
          No topology resources reported for this provider yet.
        </text>
      )}

      {/* NODES */}
      <text
        x={30}
        y={nodeY - 6}
        fill="var(--text-tertiary)"
        fontSize={10}
        letterSpacing={2}
      >
        HOSTS
      </text>

      {nodes.map((node, i) => {
        const bx = nodesStartX + i * (nodeBoxW + nodeSpacing);
        const by = nodeY;
        const cpuPct = node.cpu_usage_pct ?? node.cpu_pct ?? 0;
        const ramPct = node.ram_total_mb > 0 ? (node.ram_used_mb / node.ram_total_mb) * 100 : 0;
        const ramGB = (node.ram_total_mb / 1024).toFixed(1);
        const barW = 140;
        const barH = 6;

        return (
          <g key={node.id}>
            <rect
              x={bx} y={by} width={nodeBoxW} height={nodeBoxH} rx={10}
              fill="var(--bg-card)" stroke="var(--border)"
            />
            <circle cx={bx + 16} cy={by + 18} r={4}
              fill={node.status === "online" ? accent : "var(--red)"}
            />
            <text x={bx + 26} y={by + 22} fill="var(--text-primary)" fontSize={13} fontWeight={600}>
              {friendlyNodeName(safeText(node.name, safeText(node.id, "unknown-node")))}
            </text>
            {/* CPU bar */}
            <rect x={bx + 14} y={by + 36} width={barW} height={barH} rx={3} fill="var(--bg-tertiary)" />
            <rect x={bx + 14} y={by + 36} width={barW * Math.min(cpuPct, 100) / 100} height={barH} rx={3} fill={topoBarColor(cpuPct)} />
            <text x={bx + 160} y={by + 42} fill="var(--text-secondary)" fontSize={9}>
              CPU {cpuPct.toFixed(0)}%{node.cpu_cores ? ` (${node.cpu_cores}c)` : ""}
            </text>
            {/* RAM bar */}
            <rect x={bx + 14} y={by + 52} width={barW} height={barH} rx={3} fill="var(--bg-tertiary)" />
            <rect x={bx + 14} y={by + 52} width={barW * Math.min(ramPct, 100) / 100} height={barH} rx={3} fill={topoBarColor(ramPct)} />
            <text x={bx + 160} y={by + 58} fill="var(--text-secondary)" fontSize={9}>
              RAM {ramPct.toFixed(0)}%{Number(ramGB) > 0 ? ` (${ramGB}G)` : ""}
            </text>
          </g>
        );
      })}

      {/* Lines from nodes to VMs */}
      {vms.map((vm, i) => {
        const nodeCenter = nodeCenters[safeText(vm.node, "")];
        if (!nodeCenter) return null;
        const vmPos = vmPositions[i];
        if (!vmPos) return null;
        const x1 = nodeCenter.x;
        const y1 = nodeCenter.bottom;
        const x2 = vmPos.x;
        const y2 = vmPos.y - 28;
        const midY = (y1 + y2) / 2;
        const isRunning = vm.status === "running";
        return (
          <path
            key={`link-${vm.id}`}
            d={`M ${x1},${y1} C ${x1},${midY} ${x2},${midY} ${x2},${y2}`}
            fill="none"
            stroke={isRunning ? accent : "var(--border)"}
            strokeWidth={1.5}
            opacity={isRunning ? 0.5 : 0.3}
          />
        );
      })}

      {/* VMs */}
      {vms.length > 0 && (
        <text x={30} y={vmSectionY - 6} fill="var(--text-tertiary)" fontSize={10} letterSpacing={2}>
          VIRTUAL MACHINES
        </text>
      )}

      {vms.map((vm, i) => {
        const pos = vmPositions[i];
        if (!pos) return null;
        const isRunning = vm.status === "running";
        const isStopped = vm.status === "stopped";
        const isPaused = vm.status === "paused";

        let circleFill = "var(--bg-card)";
        let circleStroke = "var(--border)";
        if (isRunning) {
          circleFill = providerType === "vmware" ? "rgba(75,145,226,0.12)" : providerType === "aws" ? "rgba(255,153,0,0.12)" : "var(--teal-muted)";
          circleStroke = accent;
        } else if (isStopped) {
          circleFill = "var(--red-muted)";
          circleStroke = "var(--red)";
        } else if (isPaused) {
          circleFill = "var(--amber-muted)";
          circleStroke = "var(--amber)";
        }

        const vmName = safeText(vm.name, String(vm.id ?? "unknown-vm"));
        const truncatedName = vmName.length > 10 ? vmName.slice(0, 10) + "\u2026" : vmName;
        const vmid = vm.vmid || vm.id;

        return (
          <g
            key={vm.id}
            className="topo-vm-group"
            onMouseEnter={() => onVmEnter(vm)}
            onMouseMove={onVmMove}
            onMouseLeave={onVmLeave}
            style={{ cursor: "pointer" }}
          >
            {isRunning && (
              <circle
                className="topo-vm-glow running"
                cx={pos.x} cy={pos.y} r={32}
                fill="none" stroke={accent} strokeWidth={1.5} opacity={0.3}
              />
            )}
            <circle
              cx={pos.x} cy={pos.y} r={28}
              fill={circleFill} stroke={circleStroke} strokeWidth={1.5}
            />
            <text
              x={pos.x} y={pos.y + 44} textAnchor="middle"
              fill="var(--text-primary)" fontSize={10} fontWeight={500}
            >
              {truncatedName}
            </text>
            <text
              x={pos.x} y={pos.y + 56} textAnchor="middle"
              fill="var(--text-tertiary)" fontSize={9}
            >
              {vmid}
            </text>
          </g>
        );
      })}

      {/* Storage */}
      {storage.length > 0 && (
        <text x={30} y={storageSectionY - 6} fill="var(--text-tertiary)" fontSize={10} letterSpacing={2}>
          STORAGE
        </text>
      )}

      {storage.map((s, i) => {
        const bx = storageStartX + i * (storageBoxW + storageSpacing);
        const by = storageSectionY;
        const usagePct = s.total_gb > 0 ? (s.used_gb / s.total_gb) * 100 : 0;
        const barW = 160;
        const barH = 5;

        return (
          <g key={s.id}>
            <rect x={bx} y={by} width={storageBoxW} height={storageBoxH} rx={8}
              fill="var(--bg-card)" stroke="var(--border)"
            />
            <text x={bx + 12} y={by + 20} fill="var(--text-primary)" fontSize={12} fontWeight={500}>
              {friendlyStorageName(s.id, s.type)}
            </text>
            <text x={bx + 12} y={by + 34} fill="var(--text-secondary)" fontSize={9}>
              {s.used_gb.toFixed(1)} / {s.total_gb.toFixed(1)} GB ({usagePct.toFixed(0)}%)
            </text>
            <rect x={bx + 12} y={by + 42} width={barW} height={barH} rx={2} fill="var(--bg-tertiary)" />
            <rect x={bx + 12} y={by + 42} width={barW * Math.min(usagePct, 100) / 100}
              height={barH} rx={2} fill={topoBarColor(usagePct)}
            />
          </g>
        );
      })}
    </g>
  );
}

// Calculate the height a provider section needs
function calcSectionHeight(nodes: NodeInfo[], vms: VMInfo[], storage: StorageInfo[]): number {
  if (nodes.length === 0 && vms.length === 0 && storage.length === 0) return 180;
  const nodeBoxH = 80;
  const vmsPerRow = 7;
  const vmSpacingY = 100;
  const vmRows = Math.max(1, Math.ceil(vms.length / vmsPerRow));
  const vmSectionH = vmRows * vmSpacingY + 20;
  const storageBoxH = 60;
  // header(30) + nodes(nodeBoxH) + gap(60) + vms(vmSectionH) + gap(30) + storage(storageBoxH) + padding(20)
  return 30 + nodeBoxH + 60 + vmSectionH + 30 + storageBoxH + 20;
}

export default function TopologyMap() {
  const cluster = useStore((s) => s.cluster);
  const multiCluster = useStore((s) => s.multiCluster);
  const [tooltip, setTooltip] = useState<TooltipState>({
    visible: false,
    x: 0,
    y: 0,
    vm: null,
  });

  const handleVmEnter = useCallback((vm: VMInfo) => {
    setTooltip((prev) => ({ ...prev, visible: true, vm }));
  }, []);

  const handleVmMove = useCallback((e: MouseEvent) => {
    setTooltip((prev) => ({ ...prev, x: e.clientX + 12, y: e.clientY + 12 }));
  }, []);

  const handleVmLeave = useCallback(() => {
    setTooltip((prev) => ({ ...prev, visible: false, vm: null }));
  }, []);

  // Determine what providers to show
  const providers = multiCluster?.providers ?? [];
  const hasMulti = providers.length > 0;

  // Fallback: if no multi-cluster data, show single cluster
  if (!hasMulti && !cluster) {
    return (
      <div className="topo-container" style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: 400 }}>
        <span style={{ color: "var(--text-tertiary)" }}>No cluster data available</span>
      </div>
    );
  }

  // If only single provider data, wrap it
  const sections = hasMulti
    ? providers.map((p) => ({
        label: p.type.toUpperCase(),
        type: p.type,
        nodes: Array.isArray(p.state?.nodes) ? p.state.nodes : [],
        vms: Array.isArray(p.state?.vms) ? p.state.vms : [],
        storage: Array.isArray(p.state?.storage) ? p.state.storage : [],
      }))
    : cluster
    ? [{
        label: "PROXMOX",
        type: "proxmox",
        nodes: Array.isArray(cluster.nodes) ? cluster.nodes : [],
        vms: Array.isArray(cluster.vms) ? cluster.vms : [],
        storage: Array.isArray(cluster.storage) ? cluster.storage : [],
      }]
    : [];

  const hasAnyResources = sections.some(
    (section) => section.nodes.length > 0 || section.vms.length > 0 || section.storage.length > 0,
  );

  if (!hasAnyResources) {
    return (
      <div className="topo-container" style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: 400 }}>
        <span style={{ color: "var(--text-tertiary)" }}>No topology resources available yet</span>
      </div>
    );
  }

  const svgWidth = 1000;
  let currentY = 20;
  const sectionOffsets: number[] = [];

  for (const sec of sections) {
    sectionOffsets.push(currentY);
    currentY += calcSectionHeight(sec.nodes, sec.vms, sec.storage) + 40;
  }

  const svgHeight = Math.max(500, currentY);

  return (
    <div className="topo-container" style={{ position: "relative" }}>
      <svg
        className="topo-svg"
        width={svgWidth}
        height={svgHeight}
        viewBox={`0 0 ${svgWidth} ${svgHeight}`}
      >
        {sections.map((sec, i) => (
          <ProviderSection
            key={`${sec.type}-${i}`}
            label={sec.label}
            providerType={sec.type}
            nodes={sec.nodes}
            vms={sec.vms}
            storage={sec.storage}
            yOffset={sectionOffsets[i]}
            svgWidth={svgWidth}
            onVmEnter={handleVmEnter}
            onVmMove={handleVmMove}
            onVmLeave={handleVmLeave}
          />
        ))}
      </svg>

      {/* Tooltip */}
      <div
        className={`topo-tooltip${tooltip.visible ? " visible" : ""}`}
        style={{
          position: "fixed",
          transform: `translate(${tooltip.x}px, ${tooltip.y}px)`,
          pointerEvents: "none",
          top: 0,
          left: 0,
        }}
      >
        {tooltip.vm && (
          <>
            <div className="tt-title">{safeText(tooltip.vm.name, String(tooltip.vm.id ?? "Unknown VM"))}</div>
            <div className="tt-row">ID: {tooltip.vm.vmid || tooltip.vm.id}</div>
            <div className="tt-row">Status: {tooltip.vm.status}</div>
            <div className="tt-row">Node: {tooltip.vm.node}</div>
            <div className="tt-row">CPU: {tooltip.vm.cpu_cores} cores</div>
            <div className="tt-row">RAM: {tooltip.vm.ram_mb} MB</div>
            <div className="tt-row">Disk: {tooltip.vm.disk_gb} GB</div>
            <div className="tt-row">
              Uptime: {tooltip.vm.uptime_s != null ? formatUptime(tooltip.vm.uptime_s) : "N/A"}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
