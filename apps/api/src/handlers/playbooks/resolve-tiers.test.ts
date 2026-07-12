import { describe, expect, test } from "bun:test";

import type { GradedPosition } from "@/api/handlers/playbooks/position-runtime";
import type { Position } from "@/api/handlers/playbooks/positions";
import { resolveTiers } from "@/api/handlers/playbooks/resolve-standards";

const CLAUSE_ID = "cccccccc-0000-4000-8000-000000000001";
const textContent = { version: 1, type: "text" } as const;

type ClauseSnapshot = {
  preferredBody: string;
  pinnedBodyByVersion: Map<number, string>;
  variants: { rank: number; text: string }[];
};

const gradedWith = (tiers: GradedPosition["tiers"]): GradedPosition =>
  ({
    mode: "graded",
    sourceId: "11111111-1111-4111-8111-111111111111",
    issue: "Governing law",
    severity: "high",
    ask: { mode: "manual", question: "Which law?", content: textContent },
    tiers,
    enabled: true,
  }) satisfies Position;

const emptySnapshots = new Map<string, ClauseSnapshot>();

describe("resolveTiers — inline ideal", () => {
  test("resolves inline ideal, entries as ranked fallbacks, and rule texts", () => {
    const resolved = resolveTiers(
      gradedWith({
        acceptable: {
          rules: [
            { id: "ar-1", text: "  A common-law jurisdiction.  " },
            { id: "ar-2", text: "" },
          ],
          ideal: { source: "inline", text: "  England and Wales.  " },
        },
        fallback: {
          entries: [
            { id: "e-1", text: "Ireland.", label: "EU" },
            { id: "e-2", text: "Scotland." },
          ],
        },
        notAcceptable: { rules: [{ id: "nr-1", text: "Sanctioned state." }] },
      }),
      emptySnapshots,
    );

    expect(resolved.ideal).toBe("England and Wales.");
    // Empty rule text is dropped; surviving rules keep their id.
    expect(resolved.acceptableRules).toEqual([
      { id: "ar-1", text: "A common-law jurisdiction." },
    ]);
    expect(resolved.notAcceptableRules).toEqual([
      { id: "nr-1", text: "Sanctioned state." },
    ]);
    expect(resolved.fallbacks).toEqual([
      { rank: 0, label: "EU", text: "Ireland." },
      { rank: 1, text: "Scotland." },
    ]);
  });
});

describe("resolveTiers — clause ideal", () => {
  const snapshots = new Map<string, ClauseSnapshot>([
    [
      CLAUSE_ID,
      {
        preferredBody: "Latest clause body.",
        pinnedBodyByVersion: new Map([[3, "Pinned v3 body."]]),
        variants: [
          { rank: 0, text: "Variant one." },
          { rank: 1, text: "Variant two." },
        ],
      },
    ],
  ]);

  test("uses the latest clause body and appends variants after explicit entries", () => {
    const resolved = resolveTiers(
      gradedWith({
        acceptable: {
          rules: [],
          ideal: { source: "clause", clauseId: CLAUSE_ID },
        },
        fallback: { entries: [{ id: "e-1", text: "Explicit entry." }] },
        notAcceptable: { rules: [] },
      }),
      snapshots,
    );

    expect(resolved.ideal).toBe("Latest clause body.");
    // Explicit entry first (rank 0), then the two clause variants, re-ranked by
    // final array position.
    expect(resolved.fallbacks).toEqual([
      { rank: 0, text: "Explicit entry." },
      { rank: 1, text: "Variant one." },
      { rank: 2, text: "Variant two." },
    ]);
  });

  test("pins to the requested clause version", () => {
    const resolved = resolveTiers(
      gradedWith({
        acceptable: {
          rules: [],
          ideal: { source: "clause", clauseId: CLAUSE_ID, clauseVersion: 3 },
        },
        fallback: { entries: [] },
        notAcceptable: { rules: [] },
      }),
      snapshots,
    );

    expect(resolved.ideal).toBe("Pinned v3 body.");
  });
});

describe("resolveTiers — fallback cap", () => {
  test("caps merged fallbacks at 10 with explicit entries winning", () => {
    const variants = Array.from({ length: 8 }, (_, index) => ({
      rank: index,
      text: `Variant ${index}.`,
    }));
    const snapshots = new Map<string, ClauseSnapshot>([
      [
        CLAUSE_ID,
        {
          preferredBody: "Clause body.",
          pinnedBodyByVersion: new Map(),
          variants,
        },
      ],
    ]);

    const resolved = resolveTiers(
      gradedWith({
        acceptable: {
          rules: [],
          ideal: { source: "clause", clauseId: CLAUSE_ID },
        },
        fallback: {
          entries: Array.from({ length: 6 }, (_, index) => ({
            id: `e-${index}`,
            text: `Entry ${index}.`,
          })),
        },
        notAcceptable: { rules: [] },
      }),
      snapshots,
    );

    expect(resolved.fallbacks).toHaveLength(10);
    // First six are the explicit entries (they win the cap), then four variants.
    expect(resolved.fallbacks.slice(0, 6).map((f) => f.text)).toEqual([
      "Entry 0.",
      "Entry 1.",
      "Entry 2.",
      "Entry 3.",
      "Entry 4.",
      "Entry 5.",
    ]);
    expect(resolved.fallbacks[6]?.text).toBe("Variant 0.");
    expect(resolved.fallbacks[9]?.text).toBe("Variant 3.");
    // Ranks stay contiguous with array position for matchedRef resolution.
    expect(resolved.fallbacks.map((f) => f.rank)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
  });
});
