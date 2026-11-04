import { expect, test } from "bun:test";

import type { CourtTierLabel } from "@stll/api-contract/case-law-court-tiers";

import { courtCatalog } from "@/api/mcp/case-law-court-catalog-tool";

const COURTS = [
  "Krajský súd v Košiciach",
  "Najvyšší súd Slovenskej republiky",
  "Najvyšší súd",
  "Ústavný súd",
  "Krajský súd v Bratislave",
];
const TIERS: Partial<Record<string, CourtTierLabel>> = {
  "Najvyšší súd": "supreme",
  "Najvyšší súd Slovenskej republiky": "supreme",
  "Ústavný súd": "constitutional",
};
const tierOf = (court: string) => TIERS[court] ?? "regional";

test("lists one entry per court, apex spellings merged, tiers apex first", () => {
  const catalog = courtCatalog({
    admitted: new Set(COURTS),
    country: "SVK",
    courts: COURTS,
    tierOf,
  });

  expect(catalog.country).toBe("SVK");
  expect(catalog.courts.map(({ tierLabel }) => tierLabel)).toEqual([
    "constitutional",
    "supreme",
    "regional",
  ]);
  const supreme = catalog.courts.find(
    ({ tierLabel }) => tierLabel === "supreme",
  );
  expect(supreme?.courts).toHaveLength(1);
  expect(
    [
      supreme?.courts[0]?.value,
      ...(supreme?.courts[0]?.aliases ?? []),
    ].toSorted(),
  ).toEqual(["Najvyšší súd", "Najvyšší súd Slovenskej republiky"]);
  expect(
    catalog.courts.find(({ tierLabel }) => tierLabel === "regional")?.courts,
  ).toEqual([
    { value: "Krajský súd v Bratislave", aliases: [] },
    { value: "Krajský súd v Košiciach", aliases: [] },
  ]);
});

test("never names a court or spelling the source policy withholds", () => {
  // Ústavný súd's only source is withheld, as is one spelling of the apex
  // court; Krajský súd v Košiciach holds admitted decisions.
  const catalog = courtCatalog({
    admitted: new Set([
      "Najvyšší súd",
      "Krajský súd v Bratislave",
      "Krajský súd v Košiciach",
    ]),
    country: "SVK",
    courts: COURTS,
    tierOf,
  });

  const listed = catalog.courts.flatMap(({ courts }) =>
    courts.flatMap(({ value, aliases }) => [value, ...aliases]),
  );
  expect(listed).not.toContain("Ústavný súd");
  expect(listed).not.toContain("Najvyšší súd Slovenskej republiky");
  expect(catalog.courts.map(({ tierLabel }) => tierLabel)).toEqual([
    "supreme",
    "regional",
  ]);
});
