import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { DECISION_DOCKET_GRAMMARS } from "@stll/api-contract/decision-docket-grammar";
import { parseDecisionQuery } from "@stll/api-contract/decision-query-intent";
import { propertyConfig } from "@stll/property-testing";

import {
  identityAnswerPage,
  searchIdentityRole,
  withPinnedDecisions,
} from "@/api/handlers/case-law/decisions/search-identity-role";

const read = (entry: string) =>
  parseDecisionQuery(entry, { grammar: DECISION_DOCKET_GRAMMARS.CZE });

describe("what an entry's identifier does to a search", () => {
  test("a reference among other words keeps the text search and pins its decisions", () => {
    for (const entry of [
      "náhrada škody 25 Cdo 1234/2019 odpovědnost",
      "rozsudek sp. zn. 25 Cdo 1234/2019",
      "viz ECLI:CZ:NS:2019:25.CDO.1234.2019.1 k výkladu",
    ]) {
      for (const paging of [false, true]) {
        expect(searchIdentityRole(read(entry), { paging }), entry).toBe("pin");
      }
    }
  });

  test("an entry that is a reference alone is answered by what it names", () => {
    for (const entry of [
      "25 Cdo 1234/2019",
      "sp. zn. 25 Cdo 1234/2019",
      "ECLI:CZ:NS:2019:25.CDO.1234.2019.1",
    ]) {
      expect(searchIdentityRole(read(entry), { paging: false }), entry).toBe(
        "answer",
      );
      // A continuation page belongs to a text search, which an entry answered
      // by identity never has.
      expect(searchIdentityRole(read(entry), { paging: true }), entry).toBe(
        "none",
      );
    }
  });

  test("text is text", () => {
    expect(searchIdentityRole(read("náhrada škody"), { paging: false })).toBe(
      "none",
    );
    expect(searchIdentityRole(read(" "), { paging: false })).toBe("none");
  });
});

describe("a page with the named decisions pinned above it", () => {
  const ids = fc.uniqueArray(fc.integer({ min: 1, max: 40 }), {
    maxLength: 20,
  });

  test("keeps every text result, shows each decision once, and the pinned first", () => {
    fc.assert(
      fc.property(ids, ids, ids, (pinnedNumbers, extra, rankedNumbers) => {
        const hit = (number: number) => ({ id: `d${String(number)}` });
        const pinned = pinnedNumbers.map(hit);
        const pinnedIds = new Set(
          [...pinnedNumbers, ...extra].map((number) => `d${String(number)}`),
        );
        const ranked = rankedNumbers.map(hit);
        const page = withPinnedDecisions({ pinned, pinnedIds, ranked });

        expect(page.slice(0, pinned.length)).toEqual(pinned);
        const shown = page.map(({ id }) => id);
        expect(new Set(shown).size).toBe(shown.length);
        // Every text result the pin does not name stays, in its own order.
        expect(page.slice(pinned.length)).toEqual(
          ranked.filter(({ id }) => !pinnedIds.has(id)),
        );
      }),
      propertyConfig(),
    );
  });

  test("a continuation page drops what the first page pinned", () => {
    expect(
      withPinnedDecisions({
        pinned: [],
        pinnedIds: new Set(["named"]),
        ranked: [{ id: "a" }, { id: "named" }, { id: "b" }],
      }),
    ).toEqual([{ id: "a" }, { id: "b" }]);
  });
});

describe("paging an entry answered by identity", () => {
  // A docket naming three decisions at three courts.
  const named = [{ id: "a" }, { id: "b" }, { id: "c" }];

  test("the first page holds what the reference names", () => {
    expect(identityAnswerPage({ limit: 25, offset: 0, ranked: named })).toEqual(
      { type: "answer", page: named },
    );
  });

  test("a page past what the reference names is the answer's end, not a text search", () => {
    // The fault this guards: an empty slice read as "nothing answered", which
    // sent the page to the corpus search and swapped the result set.
    expect(named.slice(25, 50)).toEqual([]);
    for (const offset of [25, 50, 475]) {
      expect(identityAnswerPage({ limit: 25, offset, ranked: named })).toEqual({
        type: "answer",
        page: [],
      });
    }
  });

  test("only a reference that names nothing falls back to the text search", () => {
    for (const offset of [0, 25]) {
      expect(identityAnswerPage({ limit: 25, offset, ranked: [] })).toEqual({
        type: "none",
      });
    }
  });
});
