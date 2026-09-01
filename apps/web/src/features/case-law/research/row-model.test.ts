import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import {
  compareDecisionIds,
  mergeResearchRows,
} from "@/features/case-law/research/row-model";
import type { ResearchDecisionDisposition } from "@/features/case-law/research/row-model";

type Row = { id: string };

const rowId = fc.integer({ min: 0, max: 30 }).map((n) => `d${n}`);

const scenario = fc
  .record({
    queryIds: fc.uniqueArray(rowId, { maxLength: 20 }),
    dispositions: fc.uniqueArray(
      fc.record({
        decisionId: rowId,
        disposition: fc.constantFrom("pinned", "excluded"),
        position: fc.integer({ min: 0, max: 40 }),
      }),
      { maxLength: 12, selector: (entry) => entry.decisionId },
    ),
    // Which pinned decisions the corpus still offers facts for.
    readableShare: fc.array(fc.boolean(), { minLength: 12, maxLength: 12 }),
    showExcluded: fc.boolean(),
  })
  .map(({ dispositions, queryIds, readableShare, showExcluded }) => {
    const typed = dispositions.map((entry): ResearchDecisionDisposition => ({
      decisionId: entry.decisionId,
      disposition: entry.disposition === "pinned" ? "pinned" : "excluded",
      position: entry.position,
    }));
    const pinnedDecisions: Row[] = typed
      .filter(
        (entry, index) =>
          entry.disposition === "pinned" && (readableShare[index] ?? true),
      )
      .map((entry) => ({ id: entry.decisionId }));
    return {
      dispositions: typed,
      pinnedDecisions,
      queryRows: queryIds.map((id): Row => ({ id })),
      showExcluded,
    };
  });

describe("research table rows", () => {
  test("every decision appears at most once", () => {
    fc.assert(
      fc.property(scenario, (input) => {
        const rows = mergeResearchRows(input);
        const ids = rows.map((row) => row.decision.id);
        expect(new Set(ids).size).toBe(ids.length);
      }),
      propertyConfig(),
    );
  });

  test("readable pinned decisions lead, in pin order, whatever the query returns", () => {
    fc.assert(
      fc.property(scenario, (input) => {
        const rows = mergeResearchRows(input);
        const readable = new Set(input.pinnedDecisions.map((d) => d.id));
        const expectedPinned = input.dispositions
          .filter(
            (e) => e.disposition === "pinned" && readable.has(e.decisionId),
          )
          .toSorted(
            (a, b) =>
              a.position - b.position ||
              compareDecisionIds(a.decisionId, b.decisionId),
          )
          .map((e) => e.decisionId);
        expect(
          rows.slice(0, expectedPinned.length).map((row) => row.decision.id),
        ).toEqual(expectedPinned);
        for (const row of rows.slice(0, expectedPinned.length)) {
          expect(row.disposition).toBe("pinned");
        }
      }),
      propertyConfig(),
    );
  });

  test("excluded decisions are dropped, or kept marked when asked for", () => {
    fc.assert(
      fc.property(scenario, (input) => {
        const rows = mergeResearchRows(input);
        const excluded = new Set(
          input.dispositions
            .filter((e) => e.disposition === "excluded")
            .map((e) => e.decisionId),
        );
        for (const row of rows) {
          if (excluded.has(row.decision.id)) {
            expect(input.showExcluded).toBe(true);
            expect(row.disposition).toBe("excluded");
          }
        }
        if (input.showExcluded) {
          const shown = new Set(rows.map((row) => row.decision.id));
          for (const decision of input.queryRows) {
            if (excluded.has(decision.id)) {
              expect(shown.has(decision.id)).toBe(true);
            }
          }
        }
      }),
      propertyConfig(),
    );
  });

  test("query rows keep their relative order after the pins", () => {
    fc.assert(
      fc.property(scenario, (input) => {
        const rows = mergeResearchRows(input);
        const pinnedCount = rows.filter(
          (row) => row.disposition === "pinned",
        ).length;
        const tail = rows.slice(pinnedCount).map((row) => row.decision.id);
        const expectedTail = input.queryRows
          .map((d) => d.id)
          .filter((id) => tail.includes(id));
        expect(tail).toEqual(expectedTail);
      }),
      propertyConfig(),
    );
  });

  test("a pinned decision without facts is absent instead of blank", () => {
    const rows = mergeResearchRows({
      dispositions: [
        { decisionId: "gone", disposition: "pinned", position: 1 },
        { decisionId: "kept", disposition: "pinned", position: 2 },
      ],
      pinnedDecisions: [{ id: "kept" }],
      queryRows: [{ id: "q1" }],
      showExcluded: false,
    });
    expect(rows.map((row) => row.decision.id)).toEqual(["kept", "q1"]);
  });
});
