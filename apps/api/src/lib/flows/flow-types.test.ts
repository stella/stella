import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  flowDefinitionInputSchema,
  MAX_FLOW_STEPS,
} from "@/api/lib/flows/flow-types";

const WORKSPACE_UUID = "11111111-1111-4111-8111-111111111111";

const aiStep = () => ({
  kind: "ai" as const,
  name: "Draft",
  prompt: "Summarize the documents.",
  includeDocuments: true,
});

const baseDefinition = (
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> => ({
  name: "My workflow",
  description: null,
  steps: [aiStep()],
  trigger: { type: "manual" },
  enabled: true,
  ...overrides,
});

const parse = (input: unknown) => v.safeParse(flowDefinitionInputSchema, input);

describe("flowDefinitionInputSchema step bounds", () => {
  test("accepts a minimal single-step definition", () => {
    expect(parse(baseDefinition()).success).toBe(true);
  });

  test("rejects an empty step list", () => {
    expect(parse(baseDefinition({ steps: [] })).success).toBe(false);
  });

  test(`rejects more than MAX_FLOW_STEPS (${String(MAX_FLOW_STEPS)}) steps`, () => {
    const steps = Array.from({ length: MAX_FLOW_STEPS + 1 }, aiStep);
    expect(parse(baseDefinition({ steps })).success).toBe(false);
  });

  test("accepts exactly MAX_FLOW_STEPS steps", () => {
    const steps = Array.from({ length: MAX_FLOW_STEPS }, aiStep);
    expect(parse(baseDefinition({ steps })).success).toBe(true);
  });

  test("rejects a blank step name", () => {
    const steps = [{ ...aiStep(), name: "   " }];
    expect(parse(baseDefinition({ steps })).success).toBe(false);
  });
});

describe("flowDefinitionInputSchema schedule bounds", () => {
  const scheduleTrigger = (schedule: Record<string, unknown>) => ({
    type: "schedule",
    workspaceId: WORKSPACE_UUID,
    schedule,
  });

  test("accepts an in-range daily schedule", () => {
    const trigger = scheduleTrigger({ frequency: "daily", hourUtc: 9 });
    expect(parse(baseDefinition({ trigger })).success).toBe(true);
  });

  test("rejects hourUtc above 23", () => {
    const trigger = scheduleTrigger({ frequency: "daily", hourUtc: 24 });
    expect(parse(baseDefinition({ trigger })).success).toBe(false);
  });

  test("rejects a negative hourUtc", () => {
    const trigger = scheduleTrigger({ frequency: "daily", hourUtc: -1 });
    expect(parse(baseDefinition({ trigger })).success).toBe(false);
  });

  test("rejects dayOfWeek above 6", () => {
    const trigger = scheduleTrigger({
      frequency: "weekly",
      hourUtc: 8,
      dayOfWeek: 7,
    });
    expect(parse(baseDefinition({ trigger })).success).toBe(false);
  });

  test("rejects dayOfMonth of 0 and above 28", () => {
    const zero = scheduleTrigger({
      frequency: "monthly",
      hourUtc: 8,
      dayOfMonth: 0,
    });
    const high = scheduleTrigger({
      frequency: "monthly",
      hourUtc: 8,
      dayOfMonth: 29,
    });
    expect(parse(baseDefinition({ trigger: zero })).success).toBe(false);
    expect(parse(baseDefinition({ trigger: high })).success).toBe(false);
  });
});

describe("flowDefinitionInputSchema strictObject rejection", () => {
  test("rejects an unknown top-level key", () => {
    expect(parse(baseDefinition({ extra: "nope" })).success).toBe(false);
  });

  test("rejects an unknown key inside a step", () => {
    const steps = [{ ...aiStep(), sneaky: true }];
    expect(parse(baseDefinition({ steps })).success).toBe(false);
  });

  test("rejects an unknown key inside a schedule trigger", () => {
    const trigger = {
      type: "schedule",
      workspaceId: WORKSPACE_UUID,
      schedule: { frequency: "daily", hourUtc: 9, surprise: 1 },
    };
    expect(parse(baseDefinition({ trigger })).success).toBe(false);
  });
});

describe("flowDefinitionInputSchema normalization", () => {
  test("trims the definition name", () => {
    const result = parse(baseDefinition({ name: "  Spaced  " }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.output.name).toBe("Spaced");
    }
  });
});
