import { describe, expect, test } from "bun:test";

import { factId } from "@/features/avt/avt.test-fixtures";
import {
  orderHeldFirst,
  toFactDetailsBody,
  withFactDetails,
} from "@/features/avt/fact-details.logic";
import type { FactDetails } from "@/features/avt/types";
import { toSafeId } from "@/lib/safe-id";

const listId = toSafeId<"legalList">("0199a3c4-5b6d-7e8f-9a0b-000000009004");

const details: FactDetails = {
  occurredOn: "2021-07-01",
  occurredOnPrecision: "month",
  evidenceKind: "Bank record",
  medium: "Scanned",
  confidence: "medium",
  interpretationNote: null,
  scoring: "included",
};

const item = (suffix: number, factDetails: FactDetails | null) => ({
  id: factId(suffix),
  name: `Fact ${String(suffix)}`,
  factDetails,
});

describe("fact detail saves", () => {
  test("send the whole detail, dated with its precision", () => {
    expect(
      toFactDetailsBody({ listId, itemEntityId: factId(1), details }),
    ).toEqual({
      listId,
      itemEntityId: factId(1),
      occurredOn: { date: "2021-07-01", precision: "month" },
      evidenceKind: "Bank record",
      medium: "Scanned",
      confidence: "medium",
      interpretationNote: null,
      scoring: "included",
    });
  });

  test("send no date when the fact has none", () => {
    expect(
      toFactDetailsBody({
        listId,
        itemEntityId: factId(1),
        details: { ...details, occurredOn: null, occurredOnPrecision: null },
      }).occurredOn,
    ).toBeNull();
  });

  test("replace only the saved fact's detail in the cached pages", () => {
    const pages = [{ items: [item(1, null), item(2, details)] }];

    const next = withFactDetails(pages, factId(1), details);

    expect(next.at(0)?.items.at(0)?.factDetails).toEqual(details);
    expect(next.at(0)?.items.at(1)).toBe(pages.at(0)?.items.at(1));
  });
});

describe("anchor fact order", () => {
  test("puts held facts first and keeps list order otherwise", () => {
    const held = { ...details, scoring: "held" as const };
    const facts = [item(1, details), item(2, held), item(3, null)];

    expect(orderHeldFirst(facts).map((fact) => fact.name)).toEqual([
      "Fact 2",
      "Fact 1",
      "Fact 3",
    ]);
  });
});
