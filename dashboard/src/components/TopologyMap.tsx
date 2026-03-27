import { useState, useCallback } from "react";
import { useStore } from "../store";
import { formatUptime } from "../hooks/useFormatters";
import type { VMInfo } from "../types";

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

export default function TopologyMap() {
  const cluster = useStore((s) => s.cluster);
  const [tooltip, setTooltip] = useState<TooltipState>({
    visible: false,
    x: 0,
    y: 0,
    vm: null,
  });

  const handleVmEnter = useCallback((vm: VMInfo) => {
    setTooltip((prev) => ({ ...prev, visible: true, vm }));
  }, []);

  const handleVmMove = useCallback((e: React.MouseEvent) => {
    setTooltip((prev) => ({ ...prev, x: e.clientX + 12, y: e.clientY + 12 }));
  }, []);

  const handleVmLeave = useCallback(() => {
    setTooltip((prev) => ({ ...prev, visible: false, vm: null }));
  }, []);

  if (!cluster) {
    return (
      <div className="topo-container" style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: 400 }}>
        <span style={{ color: "var(--text-tertiary)" }}>No cluster data available</span>
      </div>
    );
  }

  const { nodes, vms, storage } = cluster;

  // Layout constants
  const svgWidth = 1000;
  const nodeY = 40;
  const nodeBoxW = 220;
  const nodeBoxH = 80;
  const nodeSpacing = 40;
  const totalNodesW = nodes.length * nodeBoxW + (nodes.length - 1) * nodeSpacing;
  const nodesStartX = (svgWidth - totalNodesW) / 2;

  const vmSectionY = 220;
  const vmsPerRow = 7;
  const vmSpacingX = 100;
  const vmSpacingY = 100;
  const vmRows = Math.ceil(vms.length / vmsPerRow);
  const vmSectionH = vmRows * vmSpacingY + 60;

  const storageSectionY = vmSectionY + vmSectionH + 50;
  const storageBoxW = 200;
  const storageBoxH = 60;
  const storageSpacing = 30;
  const totalStorageW = storage.length * storageBoxW + (storage.length - 1) * storageSpacing;
  const storageStartX = (svgWidth - totalStorageW) / 2;

  const svgHeight = Math.max(720, storageSectionY + storageBoxH + 40);

  // Build a map of node name -> center X position
  const nodeCenters: Record<string, { x: number; bottom: number }> = {};
  nodes.forEach((node, i) => {
    const x = nodesStartX + i * (nodeBoxW + nodeSpacing) + nodeBoxW / 2;
    nodeCenters[node.name] = { x, bottom: nodeY + nodeBoxH };
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
    <div className="topo-container" style={{ position: "relative" }}>
      <svg
        className="topo-svg"
        width={svgWidth}
        height={svgHeight}
        viewBox={`0 0 ${svgWidth} ${svgHeight}`}
      >
        {/* NODES section */}
        <text
          className="topo-node-label"
          x={20}
          y={nodeY - 10}
          fill="var(--text-tertiary)"
          fontSize={11}
          letterSpacing={2}
        >
          NODES
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
                className="topo-node-rect"
                x={bx}
                y={by}
                width={nodeBoxW}
                height={nodeBoxH}
                rx={10}
                fill="var(--bg-card)"
                stroke="var(--border)"
              />
              {/* Status dot */}
              <circle
                className="topo-status-dot"
                cx={bx + 16}
                cy={by + 18}
                r={4}
                fill={node.status === "online" ? "var(--teal)" : "var(--red)"}
              />
              {/* Node name */}
              <text
                className="topo-node-label"
                x={bx + 26}
                y={by + 22}
                fill="var(--text-primary)"
                fontSize={13}
                fontWeight={600}
              >
                {node.name}
              </text>
              {/* CPU bar */}
              <rect
                className="topo-bar-bg"
                x={bx + 14}
                y={by + 36}
                width={barW}
                height={barH}
                rx={3}
                fill="var(--bg-tertiary)"
              />
              <rect
                className="topo-bar-fill"
                x={bx + 14}
                y={by + 36}
                width={barW * Math.min(cpuPct, 100) / 100}
                height={barH}
                rx={3}
                fill={topoBarColor(cpuPct)}
              />
              <text
                x={bx + 160}
                y={by + 42}
                fill="var(--text-secondary)"
                fontSize={9}
              >
                CPU {cpuPct.toFixed(0)}% ({node.cpu_cores} cores)
              </text>
              {/* RAM bar */}
              <rect
                className="topo-bar-bg"
                x={bx + 14}
                y={by + 52}
                width={barW}
                height={barH}
                rx={3}
                fill="var(--bg-tertiary)"
              />
              <rect
                className="topo-bar-fill"
                x={bx + 14}
                y={by + 52}
                width={barW * Math.min(ramPct, 100) / 100}
                height={barH}
                rx={3}
                fill={topoBarColor(ramPct)}
              />
              <text
                x={bx + 160}
                y={by + 58}
                fill="var(--text-secondary)"
                fontSize={9}
              >
                RAM {ramPct.toFixed(0)}% ({ramGB} GB)
              </text>
            </g>
          );
        })}

        {/* Connection lines from nodes to VMs */}
        {vms.map((vm, i) => {
          const nodeCenter = nodeCenters[vm.node];
          if (!nodeCenter) return null;
          const vmPos = vmPositions[i];
          const x1 = nodeCenter.x;
          const y1 = nodeCenter.bottom;
          const x2 = vmPos.x;
          const y2 = vmPos.y - 28;
          const midY = (y1 + y2) / 2;
          const isRunning = vm.status === "running";

          return (
            <path
              key={`link-${vm.id}`}
              className={`topo-link ${isRunning ? "running" : "stopped"}`}
              d={`M ${x1},${y1} C ${x1},${midY} ${x2},${midY} ${x2},${y2}`}
              fill="none"
              stroke={isRunning ? "var(--teal-border)" : "var(--border)"}
              strokeWidth={1.5}
              opacity={0.6}
            />
          );
        })}

        {/* VIRTUAL MACHINES section */}
        <text
          className="topo-node-label"
          x={20}
          y={vmSectionY - 10}
          fill="var(--text-tertiary)"
          fontSize={11}
          letterSpacing={2}
        >
          VIRTUAL MACHINES
        </text>

        {vms.map((vm, i) => {
          const pos = vmPositions[i];
          const isRunning = vm.status === "running";
          const isStopped = vm.status === "stopped";
          const isPaused = vm.status === "paused";

          let circleFill = "var(--bg-card)";
          let circleStroke = "var(--border)";
          if (isRunning) {
            circleFill = "var(--teal-muted)";
            circleStroke = "var(--teal)";
          } else if (isStopped) {
            circleFill = "var(--red-muted)";
            circleStroke = "var(--red)";
          } else if (isPaused) {
            circleFill = "var(--amber-muted)";
            circleStroke = "var(--amber)";
          }

          const truncatedName = vm.name.length > 10 ? vm.name.slice(0, 10) + "\u2026" : vm.name;
          const vmid = vm.vmid || vm.id;

          return (
            <g
              key={vm.id}
              className="topo-vm-group"
              onMouseEnter={() => handleVmEnter(vm)}
              onMouseMove={handleVmMove}
              onMouseLeave={handleVmLeave}
              style={{ cursor: "pointer" }}
            >
              {isRunning && (
                <circle
                  className="topo-vm-glow running"
                  cx={pos.x}
                  cy={pos.y}
                  r={32}
                  fill="none"
                  stroke="var(--teal)"
                  strokeWidth={1.5}
                  opacity={0.3}
                />
              )}
              <circle
                className="topo-vm-circle"
                cx={pos.x}
                cy={pos.y}
                r={28}
                fill={circleFill}
                stroke={circleStroke}
                strokeWidth={1.5}
              />
              <text
                className="topo-vm-label"
                x={pos.x}
                y={pos.y + 44}
                textAnchor="middle"
                fill="var(--text-primary)"
                fontSize={10}
                fontWeight={500}
              >
                {truncatedName}
              </text>
              <text
                className="topo-vm-id-label"
                x={pos.x}
                y={pos.y + 56}
                textAnchor="middle"
                fill="var(--text-tertiary)"
                fontSize={9}
              >
                ID:{vmid}
              </text>
            </g>
          );
        })}

        {/* STORAGE section */}
        <text
          className="topo-node-label"
          x={20}
          y={storageSectionY - 10}
          fill="var(--text-tertiary)"
          fontSize={11}
          letterSpacing={2}
        >
          STORAGE
        </text>

        {storage.map((s, i) => {
          const bx = storageStartX + i * (storageBoxW + storageSpacing);
          const by = storageSectionY;
          const usagePct = s.total_gb > 0 ? (s.used_gb / s.total_gb) * 100 : 0;
          const barW = 160;
          const barH = 5;

          return (
            <g key={s.id}>
              <rect
                x={bx}
                y={by}
                width={storageBoxW}
                height={storageBoxH}
                rx={8}
                fill="var(--bg-card)"
                stroke="var(--border)"
              />
              <text
                className="topo-storage-label"
                x={bx + 12}
                y={by + 20}
                fill="var(--text-primary)"
                fontSize={12}
                fontWeight={500}
              >
                {s.id}
              </text>
              <text
                className="topo-storage-sub"
                x={bx + 12}
                y={by + 34}
                fill="var(--text-secondary)"
                fontSize={9}
              >
                {s.used_gb.toFixed(1)} / {s.total_gb.toFixed(1)} GB ({usagePct.toFixed(0)}%)
              </text>
              <rect
                className="topo-bar-bg"
                x={bx + 12}
                y={by + 42}
                width={barW}
                height={barH}
                rx={2}
                fill="var(--bg-tertiary)"
              />
              <rect
                className="topo-bar-fill"
                x={bx + 12}
                y={by + 42}
                width={barW * Math.min(usagePct, 100) / 100}
                height={barH}
                rx={2}
                fill={topoBarColor(usagePct)}
              />
            </g>
          );
        })}
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
            <div className="tt-title">{tooltip.vm.name}</div>
            <div className="tt-row">VMID: {tooltip.vm.vmid || tooltip.vm.id}</div>
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
