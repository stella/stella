import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { scanRun } from "@/api/handlers/case-law/ingestion/us-citation-scanner";
import type { CitationWorkBudget } from "@/api/handlers/case-law/ingestion/us-citation-scanner";

const identityKey = ({ value }: { value: string }) => value;

const scan = (text: string, budget: CitationWorkBudget) =>
  scanRun([{ type: "text", text }], { identityKey, budget });

describe("the scanning budget", () => {
  const cases = {
    "short forms": "Id. ".repeat(1000),
    statutes: "§ 123 ".repeat(1000),
    "unsupported authorities": "1 XYZ 2. ".repeat(1000),
    "electronic citations": "2020 WL 1. ".repeat(1000),
  } as const;

  test("stops producing candidates at the first one past the limit", () => {
    for (const [name, text] of Object.entries(cases)) {
      const budget = { limit: 10, spent: 0 };
      const scanned = scan(text, budget);
      expect({
        name,
        rejected: Result.isError(scanned) ? scanned.error._tag : "accepted",
        spent: budget.spent,
      }).toEqual({ name, rejected: "UsCitationWorkBudgetError", spent: 11 });
    }
  });

  test("admits a run that fits", () => {
    const budget = { limit: 10_000, spent: 0 };
    const scanned = scan(cases["short forms"], budget);
    expect(
      Result.isOk(scanned)
        ? scanned.value.events.filter(({ kind }) => kind === "token").length
        : 0,
    ).toBe(1000);
    expect(budget.spent).toBe(1000);
  });
});
