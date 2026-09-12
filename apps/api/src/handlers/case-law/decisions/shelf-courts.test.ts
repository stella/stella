import { describe, expect, test } from "bun:test";

import { seededCourtWeightEntries } from "@/api/handlers/case-law/court-weight-seed";
import {
  courtDocketSizes,
  selectShelfCourts,
} from "@/api/handlers/case-law/decisions/shelf-courts";
import type { FacetBucket } from "@/api/lib/search/types";

const entriesFor = seededCourtWeightEntries;

describe("selectShelfCourts", () => {
  test("ranks apex courts above the busiest court and drops the rest", () => {
    const shelf = selectShelfCourts({
      counts: [
        { court: "Okresní soud v Ostravě", count: 9000 },
        { court: "Krajský soud v Brně", count: 3000 },
        { court: "Nejvyšší soud", count: 1200 },
        { court: "Nejvyšší správní soud", count: 2000 },
        { court: "Ústavní soud", count: 400 },
      ],
      entries: entriesFor("CZE"),
      limit: 4,
    });
    expect(shelf).toEqual([
      { court: "Ústavní soud", tierLabel: "constitutional" },
      { court: "Nejvyšší správní soud", tierLabel: "supreme" },
      { court: "Nejvyšší soud", tierLabel: "supreme" },
    ]);
  });

  test("the cap trims within a tier by docket size, never across tiers", () => {
    const shelf = selectShelfCourts({
      counts: [
        { court: "Sąd Najwyższy", count: 1 },
        { court: "Naczelny Sąd Administracyjny", count: 2 },
        { court: "Trybunał Konstytucyjny", count: 0 },
      ],
      entries: entriesFor("POL"),
      limit: 2,
    });
    expect(shelf.map((shelfCourt) => shelfCourt.court)).toEqual([
      "Trybunał Konstytucyjny",
      "Naczelny Sąd Administracyjny",
    ]);
  });

  test("a jurisdiction without entries has no shelf", () => {
    expect(
      selectShelfCourts({
        counts: [{ court: "Nejvyšší soud", count: 5 }],
        entries: [],
        limit: 4,
      }),
    ).toEqual([]);
  });

  test("court names match case-insensitively, as the seed compiles them", () => {
    const shelf = selectShelfCourts({
      counts: [{ court: "COURT OF JUSTICE", count: 1 }],
      entries: entriesFor("EU"),
      limit: 4,
    });
    expect(shelf).toEqual([
      { court: "COURT OF JUSTICE", tierLabel: "constitutional" },
    ]);
  });
});

/** The shelf as it is composed: courts from the table, counts from the facets. */
const shelfOf = (courts: readonly string[], buckets: FacetBucket[]) =>
  selectShelfCourts({
    counts: courtDocketSizes({ courts, buckets }),
    entries: entriesFor("CZE"),
    limit: 4,
  }).map((shelfCourt) => shelfCourt.court);

describe("the shelf composed from the table's courts and the facets", () => {
  test("the facet bucket, not the name, orders a tier", () => {
    expect(
      shelfOf(
        ["Nejvyšší soud", "Nejvyšší správní soud"],
        [
          { value: "Nejvyšší správní soud", count: 9000 },
          { value: "Nejvyšší soud", count: 10 },
        ],
      ),
    ).toEqual(["Nejvyšší správní soud", "Nejvyšší soud"]);
  });

  test("a court the facet cap left out is listed after its tier's counted courts, by name", () => {
    expect(
      shelfOf(
        ["Nejvyšší správní soud", "Nejvyšší soud ČR", "Nejvyšší soud"],
        [{ value: "Nejvyšší soud", count: 50 }],
      ),
    ).toEqual(["Nejvyšší soud", "Nejvyšší soud ČR", "Nejvyšší správní soud"]);
  });

  test("without facets every court is still listed, in name order", () => {
    expect(
      shelfOf(["Nejvyšší správní soud", "Nejvyšší soud", "Ústavní soud"], []),
    ).toEqual(["Ústavní soud", "Nejvyšší soud", "Nejvyšší správní soud"]);
  });
});
