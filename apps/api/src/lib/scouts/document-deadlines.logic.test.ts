import { describe, expect, test } from "bun:test";

import {
  deadlineDedupeKey,
  deadlineSeverity,
  filterDeadlines,
  quoteOccursInText,
} from "@/api/lib/scouts/document-deadlines.logic";
import type { ExtractedDeadline } from "@/api/lib/scouts/document-deadlines.logic";

const NOW = new Date("2026-08-21T09:00:00.000Z");

const CONTRACT_TEXT = `
Smlouva o dílo č. 2026/014

Článek 5 – Termíny plnění
5.1 Zhotovitel se zavazuje předat dílo objednateli nejpozději
    do 30. 9. 2026.
5.2 Objednatel uhradí zálohu ve výši 40 % ceny díla do 14 dnů od podpisu.

Článek 9 – Závěrečná ustanovení
Tato smlouva byla podepsána dne 1. 8. 2026.
`;

const deadline = (
  overrides: Partial<ExtractedDeadline>,
): ExtractedDeadline => ({
  label: "Předání díla",
  dueDate: "2026-09-30",
  quote: "předat dílo objednateli nejpozději do 30. 9. 2026",
  confidence: 0.92,
  ...overrides,
});

describe("quoteOccursInText", () => {
  test("matches across line breaks and case, rejects paraphrases", () => {
    const quote = "předat dílo objednateli nejpozději do 30. 9. 2026";
    // The fixture differs from the quote in whitespace: a mutation that
    // compares raw strings would fail this assertion.
    expect(CONTRACT_TEXT.includes(quote)).toBe(false);
    expect(quoteOccursInText(quote, CONTRACT_TEXT)).toBe(true);
    expect(
      quoteOccursInText("dílo bude předáno do konce září 2026", CONTRACT_TEXT),
    ).toBe(false);
    expect(quoteOccursInText("   ", CONTRACT_TEXT)).toBe(false);
  });
});

describe("filterDeadlines", () => {
  test("drops low confidence, stale dates, and unverifiable quotes", () => {
    const kept = filterDeadlines(
      [
        deadline({}),
        deadline({ label: "Nejistý", confidence: 0.4 }),
        deadline({
          label: "Podpis",
          dueDate: "2026-08-01",
          quote: "podepsána dne 1. 8. 2026",
        }),
        deadline({
          label: "Vymyšlené",
          quote: "do 31. 12. 2026 zaplatí smluvní pokutu",
        }),
      ],
      CONTRACT_TEXT,
      NOW,
    );
    expect(kept.map((item) => item.label)).toEqual(["Předání díla"]);
  });

  test("a deadline within the past grace window is kept", () => {
    const kept = filterDeadlines(
      [deadline({ dueDate: "2026-08-16" })],
      CONTRACT_TEXT,
      NOW,
    );
    expect(kept).toHaveLength(1);
  });
});

describe("deadlineSeverity", () => {
  test("maps proximity to severity", () => {
    expect(deadlineSeverity("2026-08-25", NOW)).toBe("critical");
    expect(deadlineSeverity("2026-09-15", NOW)).toBe("warning");
    expect(deadlineSeverity("2026-12-01", NOW)).toBe("notice");
  });
});

describe("deadlineDedupeKey", () => {
  test("normalizes evidence and separates source runs and due dates", () => {
    const a = deadlineDedupeKey("run-1", "2026-09-30", "Předání díla");
    const b = deadlineDedupeKey("run-1", "2026-09-30", "  předání DÍLA ");
    expect(a).toBe(b);
    expect(deadlineDedupeKey("run-1", "2026-10-01", "Předání díla")).not.toBe(
      a,
    );
    expect(deadlineDedupeKey("run-2", "2026-09-30", "Předání díla")).not.toBe(
      a,
    );
  });
});
