import { panic } from "better-result";

import { DEFAULT_CUTOFF } from "@stll/sanctions";
import type { ParsedList } from "@stll/sanctions";

import { createSanctionsMatcherPoolCore } from "@/api/lib/lists/sanctions/matcher-pool-core";

export const checkBundledSanctionsMatcher = async (): Promise<void> => {
  const failures: string[] = [];
  const pool = createSanctionsMatcherPoolCore({
    deadlineMs: 10_000,
    reportFailure: ({ reason }) => {
      failures.push(reason);
    },
  });
  const list = {
    version: { source: "eu", publishedAt: "2026-09-20", fileId: null },
    entries: [
      {
        source: "eu",
        issuer: "EU",
        sourceId: "smoke",
        referenceNumber: null,
        entityType: "organisation",
        names: [{ name: "Česká společnost", quality: "strong" }],
        birthDates: [],
        nationalities: [],
        identifiers: [],
        addresses: [],
        programme: null,
        legalBasis: null,
        listedOn: null,
        sourceUrl: "https://eur-lex.europa.eu/",
      },
    ],
  } satisfies ParsedList;
  try {
    for (const useCache of [false, true]) {
      const response = await pool.run(
        async (session) =>
          await session.match({
            source: "eu",
            editionId: "smoke",
            list: useCache ? null : list,
            query: { name: "Česká společnost", entityType: "organisation" },
            cutoff: DEFAULT_CUTOFF,
            limit: 1,
          }),
      );
      if (
        response.status !== "completed" ||
        response.value.status !== "screened" ||
        response.value.result.possibleMatches.at(0)?.entry.sourceId !== "smoke"
      ) {
        panic(
          `Sanctions smoke pool did not screen its edition: ${failures.join(",")}`,
        );
      }
    }
  } finally {
    await pool.close();
  }
};
