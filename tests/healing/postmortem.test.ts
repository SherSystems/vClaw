import { describe, it, expect } from "vitest";
import {
  buildPostmortemPrompt,
  cleanPostmortemText,
  generatePostmortem,
} from "../../src/healing/postmortem.js";
import { LlmTimeoutError } from "../../src/agent/llm.js";
import type { Incident } from "../../src/healing/incidents.js";
import type { TicketRecord } from "../../src/healing/ticket-store.js";
import type { AIConfig } from "../../src/agent/llm.js";

// ── Fixtures ───────────────────────────────────────────────

const fixtureIncident: Incident = {
  id: "f0e9d8c7-0000-4000-8000-000000000001",
  anomaly_type: "state_change",
  severity: "critical",
  metric: "vm_status",
  labels: {
    vmid: "200",
    node: "pranavlab",
    name: "esxi-01",
    reason: "paused_io_error",
  },
  detected_at: "2026-04-18T02:11:00.000Z",
  resolved_at: "2026-04-18T02:13:01.300Z",
  status: "resolved",
  trigger_value: 1,
  description: "VM esxi-01 on pranavlab entered paused (io-error)",
  actions_taken: [
    {
      action: "snapshot_create",
      timestamp: "2026-04-18T02:11:30.000Z",
      success: true,
      details: "rhodes-safety-2026-04-18",
    },
    {
      action: "snapshot_delete",
      timestamp: "2026-04-18T02:12:00.000Z",
      success: true,
      details: "autosnap_2026-04-18 — thin-pool 92% → 76%",
    },
    {
      action: "qm_resume",
      timestamp: "2026-04-18T02:13:01.000Z",
      success: true,
      details: "qm resume 200 returned in 1.3s",
    },
  ],
  resolution: "VM esxi-01 state recovered: paused_io_error → running",
  duration_ms: 121300,
};

const fixtureTicket: TicketRecord = {
  ticket_id: "RHODES-2026-001",
  incident_id: fixtureIncident.id,
  title: "esxi-01 on pranavlab: paused_io_error",
  status: "resolved",
  opened_at: fixtureIncident.detected_at,
  resolved_at: fixtureIncident.resolved_at,
  plan_ids: ["plan-storage-pause-001"],
  comments: [],
};

// ── buildPostmortemPrompt (snapshot) ───────────────────────

describe("buildPostmortemPrompt", () => {
  it("matches the expected prompt structure (snapshot)", () => {
    const { system, user } = buildPostmortemPrompt({
      ticket: fixtureTicket,
      incident: fixtureIncident,
      planSummaries: [
        { plan_id: "plan-storage-pause-001", outcome: "completed 11/11 steps" },
      ],
    });
    // System prompt is the voice contract — locked.
    expect(system).toMatchInlineSnapshot(`
      "You are RHODES, an SRE agent that just resolved an incident. Write a postmortem in your own voice.
      Voice: technical, calm, no marketing words, no executive summary, no headers, no bullet points.
      Include specific numbers (percentages, durations, retry counts) and name the root cause clearly.
      Output exactly one paragraph of 3-6 sentences. No greeting, no sign-off, no markdown.
      If the resolution mentions specific actions (snapshot pruned, qm resume returned, etc.), name them with their durations.
      If the root cause is unclear, say so — do not invent one."
    `);
    // User prompt — snapshot the structure to lock the assembly.
    expect(user).toMatchInlineSnapshot(`
      "Ticket: RHODES-2026-001 — esxi-01 on pranavlab: paused_io_error
      Metric: vm_status
      Anomaly type: state_change
      Severity: critical
      Detected at: 2026-04-18T02:11:00.000Z
      Resolved at: 2026-04-18T02:13:01.300Z
      Total duration: 121.3s

      Labels:
        vmid: 200
        node: pranavlab
        name: esxi-01
        reason: paused_io_error

      Action timeline:
        [2026-04-18T02:11:30.000Z] snapshot_create (first, ok) — rhodes-safety-2026-04-18
        [2026-04-18T02:12:00.000Z] snapshot_delete (30000ms after prev, ok) — autosnap_2026-04-18 — thin-pool 92% → 76%
        [2026-04-18T02:13:01.000Z] qm_resume (61000ms after prev, ok) — qm resume 200 returned in 1.3s

      Plans that ran:
        - plan-storage-pause-001: completed 11/11 steps

      Final resolution reason: VM esxi-01 state recovered: paused_io_error → running

      Now write the postmortem. One paragraph, 3-6 sentences."
    `);
  });

  it("falls back when an incident has no actions", () => {
    const { user } = buildPostmortemPrompt({
      ticket: { ...fixtureTicket, plan_ids: [] },
      incident: { ...fixtureIncident, actions_taken: [] },
    });
    expect(user).toContain("Action timeline:\n  (no actions recorded)");
    expect(user).toContain("Plans that ran:\n  (no plans recorded)");
  });
});

// ── cleanPostmortemText ────────────────────────────────────

describe("cleanPostmortemText", () => {
  it("strips wrapping quotes", () => {
    expect(cleanPostmortemText('"This is the postmortem."')).toBe(
      "This is the postmortem.",
    );
  });
  it("collapses paragraph breaks into a single paragraph", () => {
    expect(cleanPostmortemText("Paragraph one.\n\nParagraph two.")).toBe(
      "Paragraph one. Paragraph two.",
    );
  });
  it("strips leading markdown markers", () => {
    expect(cleanPostmortemText("- bullet text")).toBe("bullet text");
    expect(cleanPostmortemText("# header text")).toBe("header text");
  });
});

// ── generatePostmortem timeout behaviour ───────────────────

describe("generatePostmortem", () => {
  const cfg: AIConfig = {
    provider: "anthropic",
    apiKey: "test",
    model: "claude-sonnet-4-20250514",
  };

  it("returns clean text from the injected llm", async () => {
    const llm = async () =>
      "  \"Vmid 200 entered paused (io-error). Pruned a snapshot to drop the pool to 76%.\"  ";
    const result = await generatePostmortem(
      { ticket: fixtureTicket, incident: fixtureIncident },
      cfg,
      { llm },
    );
    expect(result.timedOut).toBe(false);
    expect(result.text).toBe(
      "Vmid 200 entered paused (io-error). Pruned a snapshot to drop the pool to 76%.",
    );
    expect(result.note).toBeUndefined();
  });

  it("surfaces a re-trigger note when the llm times out", async () => {
    const llm = async () => {
      throw new LlmTimeoutError(60_000, 1, "plan");
    };
    const result = await generatePostmortem(
      { ticket: fixtureTicket, incident: fixtureIncident },
      cfg,
      { llm },
    );
    expect(result.timedOut).toBe(true);
    expect(result.text).toBeUndefined();
    expect(result.note).toContain("re-trigger from the dashboard");
  });

  it("surfaces a generic failure note for non-timeout errors", async () => {
    const llm = async () => {
      throw new Error("rate_limit");
    };
    const result = await generatePostmortem(
      { ticket: fixtureTicket, incident: fixtureIncident },
      cfg,
      { llm },
    );
    expect(result.timedOut).toBe(false);
    expect(result.text).toBeUndefined();
    expect(result.note).toContain("rate_limit");
  });

  it("treats empty llm output as a re-trigger case", async () => {
    const llm = async () => "   \n  ";
    const result = await generatePostmortem(
      { ticket: fixtureTicket, incident: fixtureIncident },
      cfg,
      { llm },
    );
    expect(result.text).toBeUndefined();
    expect(result.note).toContain("re-trigger from the dashboard");
  });
});
