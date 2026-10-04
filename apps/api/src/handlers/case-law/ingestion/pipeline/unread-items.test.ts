import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  planUnreadItems,
  readUnavailableStreaks,
  UNAVAILABLE_ITEMS_CONFIG_KEY,
  type UnavailableStreaks,
} from "@/api/handlers/case-law/ingestion/pipeline/unread-items";
import {
  TEXT_ABSENCE_REASON,
  absentDecisionTextFields,
} from "@/api/lib/case-law/decision-text";
import {
  isReadRefusal,
  isStoredReadUnavailable,
  READ_OUTCOME_METADATA_KEY,
  type StoredReadUnavailable,
  UNAVAILABLE_CYCLES_BEFORE_MARKING,
} from "@/api/lib/errors/read-outcome";
import type {
  IngestionResult,
  UnreadListedItem,
} from "@/api/lib/legal-search/ingestion-types";
import { plainTextIngestionResult } from "@/api/lib/legal-search/plain-text-assembly";

const listing = (id: string): UnreadListedItem["listing"] => ({
  ...plainTextIngestionResult({
    caseNumber: `listed ${id}`,
    court: "Court",
    country: "CZE",
    language: "cs",
    metadata: {},
    textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
    rawHash: `listing-${id}`,
    documentAst: {},
  }),
  sourceDocumentId: id,
  isListingOnly: true,
});

/**
 * The stored unavailable marker, typed as the stored shape: metadata values
 * are branded plain text, so the narrowed metadata value cannot be compared
 * with a literal directly.
 */
const storedUnavailable = (
  row: IngestionResult | undefined,
): StoredReadUnavailable => {
  const marker = row?.metadata[READ_OUTCOME_METADATA_KEY];
  if (!isStoredReadUnavailable(marker)) {
    throw new Error("expected a stored unavailable outcome");
  }
  return marker;
};

const unavailable = (id: string): UnreadListedItem => ({
  listing: listing(id),
  outcome: { type: "unavailable", cause: { kind: "no-content", status: 204 } },
});

const refused = (id: string): UnreadListedItem => ({
  listing: listing(id),
  outcome: {
    type: "refused",
    status: 403,
    scope: "document",
    cause: { kind: "http-status", retryAfter: null },
  },
});

describe("unread listed items", () => {
  test("an unavailable item holds the page until its bound, then is stored typed", () => {
    let streaks: UnavailableStreaks = {};
    for (let cycle = 1; cycle < UNAVAILABLE_CYCLES_BEFORE_MARKING; cycle += 1) {
      const plan = planUnreadItems([unavailable("a")], streaks);
      expect(plan).toEqual({ terminal: [], streaks: { a: cycle }, holding: 1 });
      streaks = plan.streaks;
    }

    const spent = planUnreadItems([unavailable("a")], streaks);

    expect(spent.holding).toBe(0);
    expect(spent.streaks).toEqual({});
    expect(spent.terminal.map((row) => row.sourceDocumentId)).toEqual(["a"]);
    expect(storedUnavailable(spent.terminal.at(0))).toEqual({
      type: "unavailable",
      scope: "document",
      cause: { kind: "no-content", status: 204 },
      consecutiveCycles: UNAVAILABLE_CYCLES_BEFORE_MARKING,
    });
    expect(spent.terminal.at(0)?.rawHash).not.toBe("listing-a");
  });

  test("a refusal is stored at once and never counted", () => {
    const plan = planUnreadItems([refused("r")], {});

    expect(plan.holding).toBe(0);
    expect(plan.streaks).toEqual({});
    expect(plan.terminal.map((row) => row.sourceDocumentId)).toEqual(["r"]);
    expect(
      isReadRefusal(plan.terminal.at(0)?.metadata[READ_OUTCOME_METADATA_KEY]),
    ).toBe(true);
  });

  test("a thrown cause is stored without its error", () => {
    const plan = planUnreadItems(
      [
        {
          listing: listing("t"),
          outcome: {
            type: "unavailable",
            cause: {
              kind: "thrown",
              error: new TypeError("connection reset by 10.0.0.1"),
            },
          },
        },
      ],
      { t: UNAVAILABLE_CYCLES_BEFORE_MARKING - 1 },
    );

    expect(storedUnavailable(plan.terminal.at(0))).toEqual({
      type: "unavailable",
      scope: "document",
      cause: { kind: "thrown" },
      consecutiveCycles: UNAVAILABLE_CYCLES_BEFORE_MARKING,
    });
  });

  test("malformed stored counts are reported, not trusted", () => {
    expect(
      readUnavailableStreaks({ [UNAVAILABLE_ITEMS_CONFIG_KEY]: { a: 0 } }).type,
    ).toBe("malformed");
    expect(readUnavailableStreaks({ other: 1 })).toEqual({
      type: "read",
      streaks: {},
    });
  });

  const ITEM_IDS = ["a", "b", "c"] as const;

  test("page holds exactly while an item is unavailable for fewer consecutive cycles than the bound", () => {
    // Model: each cycle, each listed item is read or unavailable. The page
    // holds while any unavailable item's consecutive run is under the bound,
    // and advances (ending the model) on the first cycle where none is. A
    // read resets an item's run; two items cannot take turns holding it.
    assertProperty(
      "page holds exactly while an item is unavailable for fewer consecutive cycles than the bound",
      fc.property(
        fc.array(fc.subarray([...ITEM_IDS]), { minLength: 1, maxLength: 12 }),
        (cycles) => {
          let streaks: UnavailableStreaks = {};
          const runs = new Map<string, number>();
          for (const unavailableIds of cycles) {
            for (const id of ITEM_IDS) {
              runs.set(
                id,
                unavailableIds.includes(id) ? (runs.get(id) ?? 0) + 1 : 0,
              );
            }
            const plan = planUnreadItems(
              unavailableIds.map((id) => unavailable(id)),
              streaks,
            );
            const holding = unavailableIds.filter(
              (id) => (runs.get(id) ?? 0) < UNAVAILABLE_CYCLES_BEFORE_MARKING,
            );
            expect(plan.holding).toBe(holding.length);
            expect(
              plan.terminal
                .map(
                  (row) =>
                    row.sourceDocumentId ??
                    panic("a terminal unread row has no publisher identity"),
                )
                .toSorted(),
            ).toEqual(
              unavailableIds.filter((id) => !holding.includes(id)).toSorted(),
            );
            if (plan.holding === 0) {
              expect(plan.streaks).toEqual({});
              return;
            }
            streaks = plan.streaks;
          }
        },
      ),
    );
  });
});
