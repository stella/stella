import { Value } from "@sinclair/typebox/value";
import { describe, expect, test } from "bun:test";

import {
  playbookPositionsSchema,
  positionSchema,
} from "@/api/handlers/playbooks/positions";

const SOURCE_ID = "11111111-1111-4111-8111-111111111111";
const RULE_ID = "22222222-2222-4222-8222-222222222222";

const textContent = { version: 1, type: "text" } as const;

const extractPosition = {
  mode: "extract",
  sourceId: SOURCE_ID,
  issue: "Termination notice",
  ask: { question: "What is the notice period?", content: textContent },
  enabled: true,
};

const gradedPosition = {
  mode: "graded",
  sourceId: SOURCE_ID,
  issue: "Governing law",
  severity: "high",
  ask: { mode: "manual", question: "Which law governs?", content: textContent },
  tiers: {
    acceptable: {
      rules: [{ id: RULE_ID, text: "Governed by the laws of England." }],
    },
    fallback: { entries: [] },
    notAcceptable: { rules: [] },
  },
  enabled: true,
};

describe("playbookPositionsSchema — container version", () => {
  test("accepts version 2", () => {
    expect(
      Value.Check(playbookPositionsSchema, { version: 2, items: [] }),
    ).toBe(true);
  });

  test("rejects the retired version 1", () => {
    expect(
      Value.Check(playbookPositionsSchema, { version: 1, items: [] }),
    ).toBe(false);
  });
});

describe("positionSchema — extract / graded discriminated union", () => {
  test("accepts a valid extract position", () => {
    expect(Value.Check(positionSchema, extractPosition)).toBe(true);
  });

  test("accepts a valid graded position", () => {
    expect(Value.Check(positionSchema, gradedPosition)).toBe(true);
  });

  test("rejects an extract position missing enabled", () => {
    const { enabled, ...rest } = extractPosition;
    void enabled;
    expect(Value.Check(positionSchema, rest)).toBe(false);
  });

  test("rejects a graded position missing severity", () => {
    const { severity, ...rest } = gradedPosition;
    void severity;
    expect(Value.Check(positionSchema, rest)).toBe(false);
  });

  test("rejects a graded position missing tiers", () => {
    const { tiers, ...rest } = gradedPosition;
    void tiers;
    expect(Value.Check(positionSchema, rest)).toBe(false);
  });

  test("rejects a tier rule without an id", () => {
    expect(
      Value.Check(positionSchema, {
        ...gradedPosition,
        tiers: {
          ...gradedPosition.tiers,
          acceptable: { rules: [{ text: "Missing its id." }] },
        },
      }),
    ).toBe(false);
  });

  test("rejects an unknown mode", () => {
    expect(
      Value.Check(positionSchema, { ...extractPosition, mode: "review" }),
    ).toBe(false);
  });
});

describe("negotiation — optional reviewer guidance on a graded position", () => {
  test("accepts a graded position without negotiation", () => {
    expect(Value.Check(positionSchema, gradedPosition)).toBe(true);
  });

  test("accepts a graded position with a full negotiation block", () => {
    expect(
      Value.Check(positionSchema, {
        ...gradedPosition,
        negotiation: {
          rationale: "We want English law for predictable enforcement.",
          talkingPoints: [
            "Ask why local law is preferred over a neutral jurisdiction.",
            "Offer arbitration as a compromise.",
          ],
          escalation: "Escalate to the deal lead if counterparty refuses.",
        },
      }),
    ).toBe(true);
  });

  test("accepts negotiation with only some fields set", () => {
    expect(
      Value.Check(positionSchema, {
        ...gradedPosition,
        negotiation: { rationale: "Why we want this." },
      }),
    ).toBe(true);
  });

  test("rejects a talking point below the minimum length", () => {
    expect(
      Value.Check(positionSchema, {
        ...gradedPosition,
        negotiation: { talkingPoints: [""] },
      }),
    ).toBe(false);
  });

  test("rejects more than the max talking points", () => {
    expect(
      Value.Check(positionSchema, {
        ...gradedPosition,
        negotiation: {
          talkingPoints: Array.from({ length: 21 }, (_, i) => `Point ${i}`),
        },
      }),
    ).toBe(false);
  });
});

describe("askConfigSchema — auto vs manual", () => {
  test("accepts an auto ask with no stored derived result", () => {
    expect(
      Value.Check(positionSchema, {
        ...gradedPosition,
        ask: { mode: "auto" },
      }),
    ).toBe(true);
  });

  test("accepts an auto ask carrying a derived result", () => {
    expect(
      Value.Check(positionSchema, {
        ...gradedPosition,
        ask: {
          mode: "auto",
          derived: {
            question: "Which law governs?",
            content: textContent,
            rulesHash: "abc123",
          },
        },
      }),
    ).toBe(true);
  });
});
