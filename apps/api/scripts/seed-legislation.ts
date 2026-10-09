import { panic, Result } from "better-result";

import {
  currentStatuteViewerFixture,
  historicalStatuteViewerFixture,
} from "@stll/legal-ast/fixtures/statute-viewer";

import type { ScopedDb } from "@/api/db/safe-db";
import { legislationDocuments, legislationSources } from "@/api/db/schema";
import { indexLegislationDocument } from "@/api/handlers/legislation/search-index";
import { openMaintenanceDb } from "@/api/lib/db/maintenance-db";
import { refreshLegislationFacetCounts } from "@/api/lib/legal-search/legislation-facet-refresh";
import { syncLegislationWorkNamesTx } from "@/api/lib/legal-search/legislation-work-names";
import { requireLocalDevOpen } from "@/api/runtime-mode";

import { seedId } from "./seed-utils";

const SOURCE_ID = seedId("legislation-source-agent-fixtures");
const STATUTES = [
  {
    year: 2012,
    number: 89,
    title: "Občanský zákoník",
    slug: "obcansky-zakonik",
  },
  { year: 2006, number: 262, title: "Zákoník práce", slug: "zakonik-prace" },
] as const;

/** Real act identities with explicitly synthetic wording from the legal viewer fixture. */
export const seedLegislation = async (scopedDb: ScopedDb) => {
  const rows = STATUTES.flatMap(({ year, number, title, slug }) =>
    [historicalStatuteViewerFixture, currentStatuteViewerFixture].map(
      (fixture) => ({
        id: seedId(`legislation-${year}-${number}-${fixture.versionValidFrom}`),
        sourceId: SOURCE_ID,
        eli: `/eli/cz/sb/${year}/${number}`,
        title: `${number}/${year} Sb., ${title}`,
        slug: `${number}-${year}-sb-${slug}`,
        country: fixture.country,
        language: fixture.language,
        documentType: fixture.documentType,
        status: fixture.status,
        effectiveDate: fixture.effectiveDate,
        versionValidFrom: fixture.versionValidFrom,
        // Fixture display dates are inclusive; stored windows have exclusive ends.
        versionValidTo: fixture.versionValidTo === null ? null : "2024-01-01",
        publisherExpressionId: `agent:${year}-${number}-${fixture.versionValidFrom}`,
        expressionKind: fixture.expressionKind,
        windowDisposition: fixture.windowDisposition,
        windowDispositionBasis: fixture.windowDispositionBasis,
        fulltext: fixture.fulltext,
        documentAst: fixture.documentAst,
        createdAt: new Date(fixture.createdAt),
        updatedAt: new Date(fixture.updatedAt),
      }),
    ),
  );

  await scopedDb(async (tx) => {
    await tx
      .insert(legislationSources)
      .values({
        id: SOURCE_ID,
        adapterKey: "agent-fixtures",
        name: "Synthetic statute viewer fixtures",
        enabled: false,
        expressionNamespace: "agent",
        descriptor: {
          license: "public-domain",
          attribution: null,
          allowsRedistribution: true,
          allowsDerivedAi: true,
        },
      })
      .onConflictDoNothing();
    await tx.insert(legislationDocuments).values(rows).onConflictDoNothing();
    await syncLegislationWorkNamesTx(tx, rows);
  });
  // Schedules are disabled in sealed stacks: settle the read projections now.
  for (const { id } of rows) {
    const indexed = await indexLegislationDocument(id, scopedDb);
    if (Result.isError(indexed)) {
      panic(`Could not index seeded statute ${id}: ${String(indexed.error)}`);
    }
  }
  await refreshLegislationFacetCounts({ transaction: scopedDb });
};

if (import.meta.main) {
  requireLocalDevOpen("seed legislation");
  await seedLegislation(openMaintenanceDb({ readOnly: false }).transaction);
  process.exit(0);
}
