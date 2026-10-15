import { panic } from "better-result";

import type { VisualTreemapTree } from "./treemap-model";

// Court filter values remain separate from presentation names for drilling.
export const courtYearFixture = [
  {
    court: "CZ:ns",
    courtName: "Nejvyšší soud",
    courtAbbreviation: "NS",
    tier: "supreme",
    year: 2023,
    count: 12,
    citationSum: 60,
    treatment: null,
  },
  {
    court: "CZ:ns",
    courtName: "Nejvyšší soud",
    courtAbbreviation: "NS",
    tier: "supreme",
    year: 2024,
    count: 8,
    citationSum: 16,
    treatment: null,
  },
  {
    court: "CZ:us",
    courtName: "Ústavní soud",
    courtAbbreviation: "ÚS",
    tier: "constitutional",
    year: 2024,
    count: 5,
    citationSum: 45,
    treatment: null,
  },
] as const;

export const treemapFixture = {
  type: "group",
  id: "decisions",
  label: "Rozhodnutí",
  children: ["CZ:ns", "CZ:us"].map((court) => {
    const buckets = courtYearFixture.filter((bucket) => bucket.court === court);
    const first = buckets.at(0);
    if (!first) {
      panic("Fixture court requires a bucket");
    }
    return {
      type: "group",
      id: court,
      label: first.courtName,
      tier: first.tier,
      children: buckets.map(
        ({ court: filter, year, count, citationSum, treatment, tier }) => ({
          type: "bucket",
          id: `${filter}:${year}`,
          label: String(year),
          court: filter,
          year,
          count,
          citationSum,
          treatment,
          tier,
        }),
      ),
    };
  }),
} as const satisfies VisualTreemapTree;
