import { describe, expect, test } from "bun:test";

import type { CzRegionalApiItem } from "@/api/handlers/case-law/ingestion/adapters/cz-regional";
import type { CzRegionalListingIdentity } from "@/api/scripts/cz-regional-repair-plan";
import {
  CZ_REGIONAL_FEED_START,
  CZ_REGIONAL_LANGUAGE,
  checkRepairRange,
  czRegionalListingIdentity,
  czRegionalListingKeys,
  diffCzRegionalListing,
  enumerateUtcDays,
  isUtcDateString,
  toUtcDateString,
} from "@/api/scripts/cz-regional-repair-plan";

/**
 * Listing items shaped exactly as the publisher emits them: the docket
 * carries the sheet number, and the link is an `/api/finaldoc/<uuid>` URL on
 * the publisher's own host. A shortened stand-in would never reach the
 * identity rules being tested here.
 */
const listingItem = (
  overrides: Partial<CzRegionalApiItem> = {},
): CzRegionalApiItem => ({
  jednaciCislo: "11 C 153/2025-28",
  ecli: "ECLI:CZ:KSPH:2025:11.C.153.2025.1",
  soud: "Krajský soud v Praze",
  autor: "JUDr. Jana Nováková",
  predmetRizeni: "Náhrada škody",
  datumVydani: "2025-11-04",
  datumZverejneni: "2025-11-20",
  klicovaSlova: ["náhrada škody"],
  zminenaUstanoveni: ["§ 2894 zákona č. 89/2012 Sb."],
  odkaz:
    "https://rozhodnuti.justice.cz/api/finaldoc/2f0a1d6c-9c7f-4a58-bd4a-6c1e0f7a1b23",
  ...overrides,
});

describe("enumerateUtcDays", () => {
  test("includes both bounds", () => {
    expect(enumerateUtcDays({ from: "2026-02-27", to: "2026-03-02" })).toEqual([
      "2026-02-27",
      "2026-02-28",
      "2026-03-01",
      "2026-03-02",
    ]);
  });

  test("a single-day range is that day", () => {
    expect(enumerateUtcDays({ from: "2026-03-01", to: "2026-03-01" })).toEqual([
      "2026-03-01",
    ]);
  });

  test("a backwards range covers no days", () => {
    expect(enumerateUtcDays({ from: "2026-03-02", to: "2026-03-01" })).toEqual(
      [],
    );
  });

  test("leap days and year ends are real days on the walk", () => {
    expect(enumerateUtcDays({ from: "2028-02-28", to: "2028-03-01" })).toEqual([
      "2028-02-28",
      "2028-02-29",
      "2028-03-01",
    ]);
    expect(enumerateUtcDays({ from: "2025-12-31", to: "2026-01-01" })).toEqual([
      "2025-12-31",
      "2026-01-01",
    ]);
  });

  test("the step is a UTC day across a European DST boundary", () => {
    // 2026-03-29 is the spring-forward night in Prague; a local-time walk
    // would emit 2026-03-29 twice or skip it.
    expect(enumerateUtcDays({ from: "2026-03-28", to: "2026-03-30" })).toEqual([
      "2026-03-28",
      "2026-03-29",
      "2026-03-30",
    ]);
    // …and the autumn one.
    expect(enumerateUtcDays({ from: "2026-10-24", to: "2026-10-26" })).toEqual([
      "2026-10-24",
      "2026-10-25",
      "2026-10-26",
    ]);
  });

  test("every emitted day is a day the range's length accounts for", () => {
    const days = enumerateUtcDays({ from: "2020-10-01", to: "2021-10-01" });
    expect(days.length).toBe(366);
    expect(days.at(0)).toBe(CZ_REGIONAL_FEED_START);
    expect(days.at(-1)).toBe("2021-10-01");
    expect(new Set(days).size).toBe(days.length);
  });
});

describe("isUtcDateString", () => {
  test("accepts a real UTC day", () => {
    for (const value of ["2020-10-01", "2028-02-29", "2026-12-31"]) {
      expect(isUtcDateString(value)).toBe(true);
    }
  });

  test("rejects what the shape alone would admit", () => {
    for (const value of [
      "2026-02-31",
      "2026-13-01",
      "2026-00-10",
      "2026-1-1",
      "26-01-01",
      "2026-01-01T00:00:00Z",
      "yesterday",
      "",
    ]) {
      expect(isUtcDateString(value)).toBe(false);
    }
  });

  test("round-trips a timestamp's own UTC day", () => {
    // 23:30 in Prague on 2026-03-01 is already 2026-03-01 in UTC only
    // because the offset is +01:00; the conversion is what decides.
    const date = new Date("2026-03-01T23:30:00.000Z");
    expect(toUtcDateString(date)).toBe("2026-03-01");
    expect(isUtcDateString(toUtcDateString(date))).toBe(true);
  });
});

describe("czRegionalListingIdentity", () => {
  test("the finaldoc link's last segment is the identity", () => {
    expect(czRegionalListingIdentity(listingItem())).toEqual({
      type: "document",
      sourceDocumentId: "2f0a1d6c-9c7f-4a58-bd4a-6c1e0f7a1b23",
    });
  });

  test("a link with a query or trailing slash still names the document", () => {
    for (const odkaz of [
      "https://rozhodnuti.justice.cz/api/finaldoc/2f0a1d6c-9c7f-4a58-bd4a-6c1e0f7a1b23/",
      "https://rozhodnuti.justice.cz/api/finaldoc/2f0a1d6c-9c7f-4a58-bd4a-6c1e0f7a1b23?format=json",
    ]) {
      expect(czRegionalListingIdentity(listingItem({ odkaz }))).toEqual({
        type: "document",
        sourceDocumentId: "2f0a1d6c-9c7f-4a58-bd4a-6c1e0f7a1b23",
      });
    }
  });

  test("without a link, identity falls back to the docket alone", () => {
    // The sheet number is dropped: it names where the document sits in the
    // file, not the case, and the stored row is keyed on the docket.
    const fallback = {
      type: "case-number",
      caseNumber: "11 C 153/2025",
      language: CZ_REGIONAL_LANGUAGE,
    } as const satisfies CzRegionalListingIdentity;
    for (const odkaz of [null, ""] as const) {
      expect(czRegionalListingIdentity(listingItem({ odkaz }))).toEqual(
        fallback,
      );
    }
    // …and when the publisher omits the field altogether, which is a
    // different shape from a null one under exactOptionalPropertyTypes.
    const { odkaz, ...withoutLink } = listingItem();
    expect(typeof odkaz).toBe("string");
    expect(czRegionalListingIdentity(withoutLink)).toEqual(fallback);
  });

  test("an item the adapter would drop is unidentifiable", () => {
    for (const overrides of [
      { jednaciCislo: null },
      { jednaciCislo: "" },
      { soud: null },
      { soud: "" },
    ] satisfies Partial<CzRegionalApiItem>[]) {
      expect(czRegionalListingIdentity(listingItem(overrides))).toEqual({
        type: "unidentifiable",
      });
    }
  });
});

describe("czRegionalListingKeys", () => {
  test("collects each identity half once, into its own lookup", () => {
    const keys = czRegionalListingKeys([
      listingItem(),
      listingItem(),
      listingItem({
        jednaciCislo: "31 Cm 8/2024-102",
        odkaz: null,
      }),
      listingItem({ jednaciCislo: "31 Cm 8/2024-115", odkaz: null }),
      listingItem({ soud: null }),
    ]);
    expect(keys).toEqual({
      documentIds: ["2f0a1d6c-9c7f-4a58-bd4a-6c1e0f7a1b23"],
      // Both sheets of one docket ask the same question.
      caseNumbers: ["31 Cm 8/2024"],
    });
  });
});

describe("diffCzRegionalListing", () => {
  const held = {
    documentIds: new Set(["2f0a1d6c-9c7f-4a58-bd4a-6c1e0f7a1b23"]),
    caseNumbers: new Set(["31 Cm 8/2024"]),
  };

  test("an item whose document id is stored is held", () => {
    const diff = diffCzRegionalListing({ items: [listingItem()], held });
    expect(diff.held.length).toBe(1);
    expect(diff.missing).toEqual([]);
  });

  test("an item whose document id is not stored is missing, verbatim", () => {
    const item = listingItem({
      odkaz:
        "https://rozhodnuti.justice.cz/api/finaldoc/8b41c2de-5a90-4f11-9c33-af07b21d64ee",
    });
    const diff = diffCzRegionalListing({ items: [item], held });
    expect(diff.missing).toEqual([item]);
    expect(diff.held).toEqual([]);
  });

  test("a linkless item matches a row stored under the docket", () => {
    const stored = listingItem({
      jednaciCislo: "31 Cm 8/2024-102",
      odkaz: null,
    });
    const absent = listingItem({
      jednaciCislo: "44 Co 91/2023-7",
      odkaz: null,
    });
    const diff = diffCzRegionalListing({ items: [stored, absent], held });
    expect(diff.held).toEqual([stored]);
    expect(diff.missing).toEqual([absent]);
  });

  test("a stored docket does not hold a linked item of the same case", () => {
    // The two halves of the identity index are disjoint: a row keyed on the
    // docket is stored without a document id, so it cannot answer for an
    // item the publisher now links.
    const linked = listingItem({
      jednaciCislo: "31 Cm 8/2024-102",
      odkaz:
        "https://rozhodnuti.justice.cz/api/finaldoc/c93e77a1-2b04-4e6b-8f52-1d9a5c30e7f4",
    });
    expect(diffCzRegionalListing({ items: [linked], held }).missing).toEqual([
      linked,
    ]);
  });

  test("a repeated identity is not offered for ingest twice", () => {
    const first = listingItem({
      odkaz:
        "https://rozhodnuti.justice.cz/api/finaldoc/8b41c2de-5a90-4f11-9c33-af07b21d64ee",
    });
    const repeat = listingItem({
      jednaciCislo: "11 C 153/2025-31",
      odkaz:
        "https://rozhodnuti.justice.cz/api/finaldoc/8b41c2de-5a90-4f11-9c33-af07b21d64ee",
    });
    const diff = diffCzRegionalListing({ items: [first, repeat], held });
    expect(diff.missing).toEqual([first]);
    expect(diff.duplicate).toEqual([repeat]);
  });

  test("the four buckets partition the page", () => {
    const items = [
      listingItem(),
      listingItem(),
      listingItem({
        odkaz:
          "https://rozhodnuti.justice.cz/api/finaldoc/8b41c2de-5a90-4f11-9c33-af07b21d64ee",
      }),
      listingItem({ jednaciCislo: "31 Cm 8/2024-102", odkaz: null }),
      listingItem({ jednaciCislo: "44 Co 91/2023-7", odkaz: null }),
      listingItem({ soud: null }),
    ];
    const diff = diffCzRegionalListing({ items, held });
    expect(
      diff.missing.length +
        diff.held.length +
        diff.duplicate.length +
        diff.unidentifiable.length,
    ).toBe(items.length);
    expect(diff.missing.length).toBe(2);
    expect(diff.held.length).toBe(2);
    expect(diff.duplicate.length).toBe(1);
    expect(diff.unidentifiable.length).toBe(1);
  });

  test("an empty page diffs to empty buckets", () => {
    expect(diffCzRegionalListing({ items: [], held })).toEqual({
      missing: [],
      held: [],
      unidentifiable: [],
      duplicate: [],
    });
  });
});

describe("checkRepairRange", () => {
  test("accepts a forward range, with or without a resume point", () => {
    expect(
      checkRepairRange({ from: "2020-10-01", to: "2026-08-11", after: null }),
    ).toEqual({ type: "valid" });
    expect(
      checkRepairRange({
        from: "2020-10-01",
        to: "2026-08-11",
        after: "2024-01-31",
      }),
    ).toEqual({ type: "valid" });
  });

  test("a single-day range is valid", () => {
    expect(
      checkRepairRange({ from: "2026-03-01", to: "2026-03-01", after: null }),
    ).toEqual({ type: "valid" });
  });

  test("a backwards range is refused before anything is contacted", () => {
    const check = checkRepairRange({
      from: "2026-03-02",
      to: "2026-03-01",
      after: null,
    });
    expect(check.type).toBe("invalid");
    expect(check.type === "invalid" ? check.message : "").toContain("--from");
  });

  test("each bound is named in the refusal it causes", () => {
    for (const [flag, input] of [
      ["--from", { from: "2026-02-31", to: "2026-03-01", after: null }],
      ["--to", { from: "2026-03-01", to: "not-a-date", after: null }],
      [
        "--after",
        { from: "2026-03-01", to: "2026-03-02", after: "2026-13-01" },
      ],
    ] as const) {
      const check = checkRepairRange(input);
      expect(check.type).toBe("invalid");
      expect(check.type === "invalid" ? check.message : "").toContain(flag);
    }
  });
});
