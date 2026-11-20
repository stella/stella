import { panic, Result } from "better-result";

import type { Block, DocumentAst } from "@stll/legal-ast/document-ast";
import { section51StatuteAst } from "@stll/legal-ast/fixtures/cz-262-2006-section-51";
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
export const SECTION_51_VERSION_DATE = "2025-06-01";

/** The ELI of a seeded act of the Czech collection. */
export const seededStatuteEli = ({
  year,
  number,
}: {
  year: number;
  number: number;
}) => `/eli/cz/sb/${String(year)}/${String(number)}`;

/** The id of one seeded consolidation, named by the day it took effect. */
export const seededStatuteVersionId = ({
  year,
  number,
  versionValidFrom,
}: {
  year: number;
  number: number;
  versionValidFrom: string;
}) =>
  seedId<"legislationDocument">(
    `legislation-${String(year)}-${String(number)}-${versionValidFrom}`,
  );

const STATUTES = [
  {
    year: 2012,
    number: 89,
    title: "Občanský zákoník",
    slug: "obcansky-zakonik",
  },
  { year: 2006, number: 262, title: "Zákoník práce", slug: "zakonik-prace" },
] as const;

/**
 * A synthetic act consolidated many times, so a reader can see how one
 * provision lived through the act's versions: § 1 never changes, § 2 changes
 * once (and is reprinted once with other spacing), § 3 is inserted part way,
 * and § 4 changes only in a consolidation that is not yet in force. Every
 * wording is invented for the fixture.
 */
export const SYNTHETIC_PROCEDURE_ACT = {
  year: 2024,
  number: 998,
  title: "998/2024 Sb., Synthetic procedure act",
  slug: "998-2024-sb-synthetic-procedure-act",
} as const;

/** Each consolidation's first day, oldest first; the last is not in force yet. */
export const SYNTHETIC_PROCEDURE_ACT_VERSIONS = [
  "2019-01-01",
  "2020-07-01",
  "2021-01-01",
  "2022-01-01",
  "2023-07-01",
  "2024-01-01",
  "2025-01-01",
  "2026-01-01",
  "2099-09-01",
] as const;

const PROCEDURE_SECTION_2 = {
  before: "(1) Soud rozhodne o návrhu do třiceti dnů od jeho doručení.",
  after: "(1) Soud rozhodne o návrhu do šedesáti dnů od jeho doručení.",
} as const;

const provisionBlocks = (
  section: number,
  paragraphs: readonly string[],
): Block[] => [
  {
    type: "heading",
    id: `par_${String(section)}`,
    anchorId: `par_${String(section)}`,
    level: 2,
    plainText: `§ ${String(section)}`,
    inlines: [{ type: "text", text: `§ ${String(section)}` }],
  },
  ...paragraphs.map((text, index): Block => ({
    type: "paragraph",
    id: `par_${String(section)}-odst_${String(index + 1)}`,
    anchorId: `par_${String(section)}-odst_${String(index + 1)}`,
    plainText: text,
    inlines: [{ type: "text", text }],
  })),
];

const syntheticProcedureAst = (validFrom: string): DocumentAst => {
  const section2 =
    validFrom < "2022-01-01"
      ? PROCEDURE_SECTION_2.before
      : PROCEDURE_SECTION_2.after;
  return {
    version: 1,
    source: {
      system: "agent-fixtures",
      documentId: "",
      webUrl: "",
      printUrl: "",
    },
    metadata: {
      caseNumber: null,
      ecli: null,
      court: null,
      decisionDate: null,
      decisionType: null,
      keywords: [],
      statutes: [],
    },
    blocks: [
      ...provisionBlocks(1, [
        "Tento zákon upravuje postup soudu a účastníků v syntetickém řízení.",
      ]),
      ...provisionBlocks(2, [
        // The 2024 consolidation reprints the same words with a doubled
        // space: spacing alone is not a change of the provision.
        validFrom === "2024-01-01"
          ? section2.replace("návrhu do", "návrhu  do")
          : section2,
        "(2) Lhůtu podle odstavce 1 lze jednou prodloužit.",
      ]),
      ...(validFrom < "2023-07-01"
        ? []
        : provisionBlocks(3, ["(1) Účastník může podat návrh elektronicky."])),
      ...provisionBlocks(4, [
        validFrom < "2099-09-01"
          ? "Rozhodnutí se doručuje do vlastních rukou."
          : "Rozhodnutí se doručuje do datové schránky.",
      ]),
    ],
  };
};

const syntheticProcedureRows = () =>
  SYNTHETIC_PROCEDURE_ACT_VERSIONS.map((versionValidFrom, index) => {
    const { year, number, title, slug } = SYNTHETIC_PROCEDURE_ACT;
    const documentAst = syntheticProcedureAst(versionValidFrom);
    const inForce = versionValidFrom === "2026-01-01";
    const future = index === SYNTHETIC_PROCEDURE_ACT_VERSIONS.length - 1;
    return {
      id: seededStatuteVersionId({ year, number, versionValidFrom }),
      sourceId: SOURCE_ID,
      eli: seededStatuteEli({ year, number }),
      title,
      slug,
      country: "CZE",
      language: "cs",
      documentType: "act",
      status: inForce || future ? "current" : "historical",
      effectiveDate: SYNTHETIC_PROCEDURE_ACT_VERSIONS[0],
      versionValidFrom,
      // Stored windows end on the day the next consolidation opens.
      versionValidTo: SYNTHETIC_PROCEDURE_ACT_VERSIONS[index + 1] ?? null,
      publisherExpressionId: `agent:${String(year)}-${String(number)}-${versionValidFrom}`,
      expressionKind: "consolidation" as const,
      windowDisposition: "effective" as const,
      windowDispositionBasis: null,
      fulltext: documentAst.blocks
        .map(({ plainText }) => plainText)
        .join("\n\n"),
      documentAst,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    };
  });

/** Seed Czech acts with synthetic viewer wording and one public AST excerpt. */
export const seedLegislation = async (scopedDb: ScopedDb) => {
  const viewerRows = STATUTES.flatMap(({ year, number, title, slug }) =>
    [historicalStatuteViewerFixture, currentStatuteViewerFixture].map(
      (fixture) => {
        const isSection51Statute = slug === "zakonik-prace";
        const isCurrentSection51Version =
          isSection51Statute && fixture.status === "current";
        const documentAst = isCurrentSection51Version
          ? section51StatuteAst
          : fixture.documentAst;
        const versionValidFrom = isCurrentSection51Version
          ? SECTION_51_VERSION_DATE
          : fixture.versionValidFrom;
        const historicalWindowEnd = isSection51Statute
          ? SECTION_51_VERSION_DATE
          : "2024-01-01";

        return {
          id: seededStatuteVersionId({ year, number, versionValidFrom }),
          sourceId: SOURCE_ID,
          eli: seededStatuteEli({ year, number }),
          title: `${number}/${year} Sb., ${title}`,
          slug: `${number}-${year}-sb-${slug}`,
          country: fixture.country,
          language: fixture.language,
          documentType: fixture.documentType,
          status: fixture.status,
          effectiveDate: isCurrentSection51Version
            ? SECTION_51_VERSION_DATE
            : fixture.effectiveDate,
          versionValidFrom,
          // Fixture display dates are inclusive; stored windows have exclusive ends.
          versionValidTo:
            fixture.versionValidTo === null ? null : historicalWindowEnd,
          publisherExpressionId: `agent:${year}-${number}-${versionValidFrom}`,
          expressionKind: fixture.expressionKind,
          windowDisposition: fixture.windowDisposition,
          windowDispositionBasis: fixture.windowDispositionBasis,
          fulltext:
            documentAst === null
              ? fixture.fulltext
              : documentAst.blocks
                  .map(({ plainText }) => plainText)
                  .join("\n\n"),
          documentAst,
          createdAt: new Date(fixture.createdAt),
          updatedAt: new Date(fixture.updatedAt),
        };
      },
    ),
  );
  const rows = [...viewerRows, ...syntheticProcedureRows()];

  await scopedDb(async (tx) => {
    await tx
      .insert(legislationSources)
      .values({
        id: SOURCE_ID,
        adapterKey: "agent-fixtures",
        name: "Synthetic statute fixtures and Czech public section excerpt",
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
