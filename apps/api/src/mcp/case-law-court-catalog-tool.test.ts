import { expect, test } from "bun:test";

import type { CourtTierLabel } from "@stll/api-contract/case-law-court-tiers";

import { courtCatalog } from "@/api/mcp/case-law-court-catalog-tool";

test("lists one entry per court, apex spellings merged, tiers apex first", () => {
  const tiers: Partial<Record<string, CourtTierLabel>> = {
    "Najvyšší súd": "supreme",
    "Najvyšší súd Slovenskej republiky": "supreme",
    "Ústavný súd": "constitutional",
  };
  const catalog = courtCatalog({
    country: "SVK",
    courts: [
      "Krajský súd v Košiciach",
      "Najvyšší súd Slovenskej republiky",
      "Najvyšší súd",
      "Ústavný súd",
      "Krajský súd v Bratislave",
    ],
    tierOf: (court) => tiers[court] ?? "regional",
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
