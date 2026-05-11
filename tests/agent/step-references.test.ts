import { describe, it, expect } from "vitest";
import {
  resolveStepReferences,
  type CapturedStepOutput,
} from "../../src/agent/step-references.js";

const ok = (step_id: string, data: unknown): CapturedStepOutput => ({
  step_id,
  data,
  success: true,
});
const fail = (step_id: string, error: string): CapturedStepOutput => ({
  step_id,
  data: undefined,
  success: false,
  error,
});

describe("resolveStepReferences", () => {
  it("passes through plain values unchanged", () => {
    const out = resolveStepReferences(
      { x: 1, y: "hello", z: [1, 2, 3] },
      [],
    );
    expect(out).toEqual({ x: 1, y: "hello", z: [1, 2, 3] });
  });

  it("resolves a simple field reference", () => {
    const outputs = [ok("step_1", { instance_id: "i-abc123" })];
    const out = resolveStepReferences(
      { instance_id: "${step_1.instance_id}" },
      outputs,
    );
    expect(out).toEqual({ instance_id: "i-abc123" });
  });

  it("preserves native types when the whole string is a placeholder", () => {
    const outputs = [ok("step_1", { count: 42, vms: [{ id: 100 }] })];
    const out = resolveStepReferences(
      { count: "${step_1.count}", first_vm: "${step_1.vms[0]}" },
      outputs,
    );
    expect(out).toEqual({ count: 42, first_vm: { id: 100 } });
  });

  it("interpolates inside surrounding text as a string", () => {
    const outputs = [ok("step_1", { name: "rhodes-test-1" })];
    const out = resolveStepReferences(
      { description: "Migrating ${step_1.name} to Proxmox" },
      outputs,
    );
    expect(out).toEqual({ description: "Migrating rhodes-test-1 to Proxmox" });
  });

  it("walks nested objects and arrays", () => {
    const outputs = [ok("step_1", { id: "vpc-x" })];
    const out = resolveStepReferences(
      {
        nested: { vpc: "${step_1.id}" },
        list: ["${step_1.id}", "literal"],
      },
      outputs,
    );
    expect(out).toEqual({
      nested: { vpc: "vpc-x" },
      list: ["vpc-x", "literal"],
    });
  });

  it("supports array indexing with bracket syntax", () => {
    const outputs = [ok("step_1", { subnets: [{ id: "subnet-1" }, { id: "subnet-2" }] })];
    const out = resolveStepReferences(
      { subnet_id: "${step_1.subnets[1].id}" },
      outputs,
    );
    expect(out).toEqual({ subnet_id: "subnet-2" });
  });

  it("returns the entire step data when only the step id is referenced", () => {
    const outputs = [ok("step_1", { a: 1, b: 2 })];
    const out = resolveStepReferences({ everything: "${step_1}" }, outputs);
    expect(out).toEqual({ everything: { a: 1, b: 2 } });
  });

  it("throws a descriptive error when the step is unknown", () => {
    const outputs = [ok("step_1", { id: "x" })];
    expect(() =>
      resolveStepReferences(
        { instance_id: "${step_99.id}" },
        outputs,
        "step_2",
      ),
    ).toThrow(/unknown step "step_99"/);
  });

  it("throws when the referenced step failed", () => {
    const outputs = [fail("step_1", "AWS not reachable")];
    expect(() =>
      resolveStepReferences(
        { instance_id: "${step_1.id}" },
        outputs,
        "step_2",
      ),
    ).toThrow(/which failed: AWS not reachable/);
  });

  it("throws when descending into a primitive", () => {
    const outputs = [ok("step_1", "just a string")];
    expect(() =>
      resolveStepReferences({ x: "${step_1.foo}" }, outputs, "step_2"),
    ).toThrow(/descend into a primitive/);
  });

  it("throws when the path resolves to undefined", () => {
    const outputs = [ok("step_1", { a: 1 })];
    expect(() =>
      resolveStepReferences({ x: "${step_1.does_not_exist}" }, outputs, "step_2"),
    ).toThrow(/resolved to undefined/);
  });

  it("includes step output shape in the error for debugging", () => {
    const outputs = [ok("step_1", { vms: [{ id: 1 }] })];
    expect(() =>
      resolveStepReferences({ x: "${step_1.containers}" }, outputs, "step_2"),
    ).toThrow(/data shape/);
  });

  it("handles step_r1 (replan) IDs identically to step_1", () => {
    const outputs = [ok("step_r1", { id: "x" })];
    const out = resolveStepReferences({ id: "${step_r1.id}" }, outputs);
    expect(out).toEqual({ id: "x" });
  });

  it("handles the realistic AWS migration case from the bug report", () => {
    const outputs = [
      ok("step_1", {
        instances: [
          { instance_id: "i-0d4f82c2c1125fc80", name: "rhodes-test-1", state: "running" },
        ],
      }),
    ];
    const out = resolveStepReferences(
      { instance_id: "${step_1.instances[0].instance_id}" },
      outputs,
      "step_2",
    );
    expect(out).toEqual({ instance_id: "i-0d4f82c2c1125fc80" });
  });
});
