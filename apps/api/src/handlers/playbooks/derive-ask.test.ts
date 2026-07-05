import { describe, expect, test } from "bun:test";

import {
  computeRulesHash,
  deriveAutoAsks,
} from "@/api/handlers/playbooks/derive-ask";
import type { DeriveAskGenerate } from "@/api/handlers/playbooks/derive-ask";
import type { GradedPosition } from "@/api/handlers/playbooks/position-runtime";
import type { PlaybookPositions } from "@/api/handlers/playbooks/positions";
import { toSafeId } from "@/api/lib/branded-types";

const textContent = { version: 1, type: "text" } as const;

const graded = (overrides: Partial<GradedPosition> = {}): GradedPosition => ({
  mode: "graded",
  sourceId: "11111111-1111-4111-8111-111111111111",
  issue: "Governing law",
  severity: "high",
  ask: { mode: "auto" },
  tiers: {
    acceptable: { rules: [{ id: "ar-1", text: "A common-law jurisdiction." }] },
    fallback: { entries: [] },
    notAcceptable: { rules: [] },
  },
  enabled: true,
  ...overrides,
});

const container = (position: GradedPosition): PlaybookPositions => ({
  version: 2,
  items: [position],
});

const deps = {
  organizationId: toSafeId<"organization">("org_1"),
  orgAIConfig: null,
  promptCachingEnabled: false,
};

describe("computeRulesHash — stability", () => {
  test("same grading inputs produce the same hash", () => {
    expect(computeRulesHash(graded())).toBe(computeRulesHash(graded()));
  });

  test("changing a rule text produces a new hash", () => {
    const changed = graded({
      tiers: {
        acceptable: {
          rules: [{ id: "ar-1", text: "A civil-law jurisdiction." }],
        },
        fallback: { entries: [] },
        notAcceptable: { rules: [] },
      },
    });
    expect(computeRulesHash(changed)).not.toBe(computeRulesHash(graded()));
  });

  test("adding a deterministic check produces a new hash", () => {
    const withCheck = graded({
      check: { kind: "presence", expectation: "required" },
    });
    expect(computeRulesHash(withCheck)).not.toBe(computeRulesHash(graded()));
  });
});

describe("deriveAutoAsks — save resilience", () => {
  test("a successful derivation stores the derived ask with its rulesHash", async () => {
    const generate: DeriveAskGenerate = async () => ({
      question: "What law governs the agreement?",
      contentType: "text",
    });

    const position = graded();
    const result = await deriveAutoAsks(container(position), {
      ...deps,
      generate,
    });

    const [item] = result.items;
    expect(item?.mode).toBe("graded");
    if (item?.mode === "graded" && item.ask.mode === "auto") {
      expect(item.ask.derived).toEqual({
        question: "What law governs the agreement?",
        content: { version: 1, type: "text" },
        rulesHash: computeRulesHash(position),
      });
    }
  });

  test("a thrown derivation still saves, with `derived` absent", async () => {
    const generate: DeriveAskGenerate = async () => {
      throw new Error("model unavailable");
    };

    const result = await deriveAutoAsks(container(graded()), {
      ...deps,
      generate,
    });

    const [item] = result.items;
    if (item?.mode === "graded" && item.ask.mode === "auto") {
      expect(item.ask.derived).toBeUndefined();
    } else {
      throw new Error("expected a graded auto position");
    }
  });

  test("an unchanged rulesHash reuses the stored derived (no LLM call)", async () => {
    const position = graded();
    const hash = computeRulesHash(position);
    const withDerived = graded({
      ask: {
        mode: "auto",
        derived: {
          question: "Existing question?",
          content: textContent,
          rulesHash: hash,
        },
      },
    });

    let called = false;
    const generate: DeriveAskGenerate = async () => {
      called = true;
      return { question: "New?", contentType: "text" };
    };

    const result = await deriveAutoAsks(container(withDerived), {
      ...deps,
      generate,
    });

    expect(called).toBe(false);
    const [item] = result.items;
    if (item?.mode === "graded" && item.ask.mode === "auto") {
      expect(item.ask.derived?.question).toBe("Existing question?");
    }
  });

  test("manual asks and extract positions pass through untouched", async () => {
    let called = false;
    const generate: DeriveAskGenerate = async () => {
      called = true;
      return { question: "x", contentType: "text" };
    };

    const manual = graded({
      ask: { mode: "manual", question: "Manual?", content: textContent },
    });
    const result = await deriveAutoAsks(container(manual), {
      ...deps,
      generate,
    });

    expect(called).toBe(false);
    expect(result).toEqual(container(manual));
  });
});
