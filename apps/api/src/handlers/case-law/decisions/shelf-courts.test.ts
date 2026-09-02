import { describe, expect, test } from "bun:test";

import { courtWeightMapFromSeed } from "@/api/handlers/case-law/court-weight-seed";
import { selectShelfCourts } from "@/api/handlers/case-law/decisions/shelf-courts";

const seed = courtWeightMapFromSeed();
const entriesFor = (country: string) => seed.get(country) ?? [];

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
