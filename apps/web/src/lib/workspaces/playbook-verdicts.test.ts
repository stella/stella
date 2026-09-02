import { describe, expect, it } from "bun:test";

import { toSafeId } from "@/lib/safe-id";
import type { WorkspaceProperty } from "@/lib/types";
import {
  isGradableProperty,
  isPlaybookVerdictProperty,
  pairPlaybookVerdicts,
  playbookVerdictByAskId,
} from "@/lib/workspaces/playbook-verdicts";

const propertyId = (value: string) => toSafeId<"property">(value);

const baseProperty = (id: string, name: string) => ({
  id: propertyId(id),
  name,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  workspaceId: toSafeId<"workspace">("ws"),
  status: "fresh" as const,
  kinds: null,
  content: { version: 1 as const, type: "text" as const },
});

const askProperty = (id: string, name: string): WorkspaceProperty => ({
  ...baseProperty(id, name),
  tool: { version: 1, type: "ai-model", prompt: "", dependencies: [] },
});

const verdictProperty = (id: string, askId: string): WorkspaceProperty => ({
  ...baseProperty(id, `${id} verdict`),
  tool: {
    version: 1,
    type: "playbook-verdict",
    askPropertyId: propertyId(askId),
    dependencies: [],
  },
});

describe("pairPlaybookVerdicts", () => {
  it("attaches each verdict to the property it grades", () => {
    const ask = askProperty("ask-1", "Governing law");
    const paired = pairPlaybookVerdicts([ask, verdictProperty("v-1", "ask-1")]);

    expect(paired).toHaveLength(1);
    expect(paired[0]?.property.id).toBe(ask.id);
    expect(paired[0]?.verdictProperty?.id).toBe(propertyId("v-1"));
  });

  it("never returns a verdict as a property of its own", () => {
    // The whole point: a surface that maps the result cannot render a grade
    // stranded from the answer it was reached from.
    const paired = pairPlaybookVerdicts([
      askProperty("ask-1", "Governing law"),
      verdictProperty("v-1", "ask-1"),
      verdictProperty("v-orphan", "ask-missing"),
    ]);

    expect(paired.map((entry) => entry.property.id)).toEqual([
      propertyId("ask-1"),
    ]);
  });

  it("leaves an ungraded property without a verdict", () => {
    const paired = pairPlaybookVerdicts([askProperty("ask-1", "Notes")]);

    expect(paired[0]?.verdictProperty).toBeUndefined();
  });

  it("preserves the workspace's column order", () => {
    const paired = pairPlaybookVerdicts([
      askProperty("b", "Second"),
      verdictProperty("v-b", "b"),
      askProperty("a", "First"),
    ]);

    expect(paired.map((entry) => entry.property.id)).toEqual([
      propertyId("b"),
      propertyId("a"),
    ]);
  });
});

describe("playbookVerdictByAskId", () => {
  it("keys verdicts by the property they grade, not by their own id", () => {
    const byAskId = playbookVerdictByAskId([
      askProperty("ask-1", "Governing law"),
      verdictProperty("v-1", "ask-1"),
    ]);

    expect(byAskId.get(propertyId("ask-1"))?.id).toBe(propertyId("v-1"));
    expect(byAskId.get(propertyId("v-1"))).toBeUndefined();
  });
});

describe("property guards", () => {
  it("are complementary", () => {
    const ask = askProperty("ask-1", "Governing law");
    const verdict = verdictProperty("v-1", "ask-1");

    expect(isPlaybookVerdictProperty(verdict)).toBe(true);
    expect(isGradableProperty(verdict)).toBe(false);
    expect(isPlaybookVerdictProperty(ask)).toBe(false);
    expect(isGradableProperty(ask)).toBe(true);
  });
});
