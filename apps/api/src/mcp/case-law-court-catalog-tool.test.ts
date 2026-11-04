import { expect, test } from "bun:test";

import type { CourtTierLabel } from "@stll/api-contract/case-law-court-tiers";

import { courtCatalogPage } from "@/api/mcp/case-law-court-catalog-tool";

const COURTS = [
  "Krajský súd v Bratislave",
  "Krajský súd v Košiciach",
  "Najvyšší súd",
  "Najvyšší súd Slovenskej republiky",
  "Ústavný súd",
];
const TIERS: Partial<Record<string, CourtTierLabel>> = {
  "Najvyšší súd": "supreme",
  "Najvyšší súd Slovenskej republiky": "supreme",
  "Ústavný súd": "constitutional",
};
const tierOf = (court: string) => TIERS[court] ?? "regional";

test("a page lists one entry per court, apex spellings merged, tiers apex first", () => {
  const page = courtCatalogPage({
    country: "SVK",
    courts: COURTS,
    nextCursor: null,
    tierOf,
  });

  expect(page.country).toBe("SVK");
  expect(page.nextCursor).toBeNull();
  expect(page.courts.map(({ tierLabel }) => tierLabel)).toEqual([
    "constitutional",
    "supreme",
    "regional",
  ]);
  const supreme = page.courts.find(({ tierLabel }) => tierLabel === "supreme");
  expect(supreme?.courts).toHaveLength(1);
  const court = supreme?.courts[0];
  expect(new Set([court?.value, ...(court?.aliases ?? [])])).toEqual(
    new Set(["Najvyšší súd", "Najvyšší súd Slovenskej republiky"]),
  );
  expect(
    page.courts.find(({ tierLabel }) => tierLabel === "regional")?.courts,
  ).toEqual([
    { value: "Krajský súd v Bratislave", aliases: [] },
    { value: "Krajský súd v Košiciach", aliases: [] },
  ]);
});

test("a page carries the cursor the next page starts from", () => {
  const page = courtCatalogPage({
    country: "SVK",
    courts: COURTS.slice(0, 2),
    nextCursor: "cursor",
    tierOf,
  });
  expect(page.nextCursor).toBe("cursor");
  expect(page.courts).toEqual([
    {
      tierLabel: "regional",
      courts: [
        { value: "Krajský súd v Bratislave", aliases: [] },
        { value: "Krajský súd v Košiciach", aliases: [] },
      ],
    },
  ]);
});
