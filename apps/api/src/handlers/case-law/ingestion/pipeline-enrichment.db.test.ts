import { panic } from "better-result";
import { expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { authRelationsPart } from "@/api/db/auth-schema";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawDecisionFallbackIdentities,
  caseLawDecisions,
  caseLawSources,
  relations,
} from "@/api/db/schema";
import { processDecision } from "@/api/handlers/case-law/ingestion/pipeline/decision";
import type { CaseLawCorpusDependencies } from "@/api/handlers/case-law/ingestion/pipeline/dependencies";
import { PROCESS_DECISION_STATUS } from "@/api/handlers/case-law/ingestion/pipeline/outcomes";
import { createSafeId } from "@/api/lib/branded-types";
import {
  absentDecisionTextFields,
  TEXT_ABSENCE_REASON,
} from "@/api/lib/case-law/decision-text";
import { corpusContentHash } from "@/api/lib/legal-search/corpus-content-hash";
import { caseLawCanonicalPayload } from "@/api/lib/legal-search/decision-payload";
import { EMPTY_AST } from "@/api/lib/legal-search/ingestion-types";
import { plainTextIngestionResult } from "@/api/lib/legal-search/plain-text-assembly";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const corpus = {
  mode: "off",
  transfer: {
    layout: "packs",
    putPacks: () => {
      throw new TypeError("Inline fixture must not transfer packs");
    },
  },
} satisfies CaseLawCorpusDependencies;

test("weak publication enrichment preserves its row and distinguishes full cohort siblings", async () => {
  const client = await createTestPglite();
  const db = drizzle({
    client,
    relations: { ...relations, ...authRelationsPart },
  });
  const scopedDb: ScopedDb = async (callback) =>
    await db.transaction(async (tx) => await callback(asTestRaw(tx)));
  const sourceId = createSafeId<"caseLawSource">();
  const publication = (fulltext: string, sourceUrl?: string) =>
    plainTextIngestionResult({
      caseNumber: "0Pu/1/2025",
      court: "Mestský súd Košice",
      country: "SVK",
      language: "sk",
      decisionDate: fulltext ? "2025-04-18" : undefined,
      decisionType: fulltext ? "Uznesenie" : undefined,
      judges: fulltext
        ? [{ nameAsPrinted: "Sudca A", role: "presiding" }]
        : undefined,
      sourceUrl,
      fulltext,
      rawHash: `${sourceUrl}:${fulltext}`,
      metadata: fulltext
        ? { publicationLabel: "first", detail: "published" }
        : { publicationLabel: "first" },
      documentAst: EMPTY_AST,
      textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
    });
  let observationOrder = 0n;
  const ingest = async (input: ReturnType<typeof publication>) => {
    observationOrder += 1n;
    const outcome = await processDecision({
      input,
      scopedDb,
      sourceId,
      corpus,
      observationOrder,
      observedAt: new Date("2026-10-29T08:00:00Z"),
    });
    expect(outcome.status).toBe(PROCESS_DECISION_STATUS.COMPLETE);
  };
  const stored = async () =>
    await db
      .select({
        id: caseLawDecisions.id,
        text: caseLawDecisions.fulltext,
        publicationHash: caseLawDecisions.fallbackPublicationHash,
      })
      .from(caseLawDecisions)
      .where(eq(caseLawDecisions.sourceId, sourceId));
  try {
    await db.insert(caseLawSources).values({
      id: sourceId,
      adapterKey: `enrichment-${sourceId}`,
      name: "Enrichment fixture",
    });
    await ingest(publication(""));
    const before = await stored();
    expect(before).toHaveLength(1);
    const original =
      before.at(0) ?? panic("Metadata observation must be stored");
    await ingest(
      publication("Prvé uznesenie.", "https://example.org/publication/first"),
    );
    expect(await stored()).toEqual([
      {
        id: original.id,
        publicationHash: original.publicationHash,
        text: "Prvé uznesenie.",
      },
    ]);
    await ingest(publication("Prvé uznesenie."));
    expect(await stored()).toHaveLength(1);
    await ingest(publication(""));
    await ingest(publication("Prvé uznesenie."));
    expect(await stored()).toHaveLength(1);
    // This isolated snapshot models the contract release; the expansion still retains this index.
    await db.execute(
      sql`DROP INDEX case_law_decisions_source_case_lang_null_idx`,
    );
    await ingest(publication("", "https://example.org/publication/second"));
    await ingest(
      publication("Druhé uznesenie.", "https://example.org/publication/second"),
    );
    await ingest(publication("Tretie uznesenie."));
    const siblings = await stored();
    expect(siblings).toHaveLength(3);
    expect(new Set(siblings.map(({ id }) => id)).size).toBe(3);
    expect(siblings.find(({ id }) => id === before.at(0)?.id)?.text).toBe(
      "Prvé uznesenie.",
    );
    await ingest(
      publication("Druhé uznesenie.", "https://example.org/publication/second"),
    );
    await ingest(publication("Tretie uznesenie."));
    expect(await stored()).toHaveLength(3);
    await ingest(publication("", "https://example.org/publication/fourth"));
    await ingest(publication("", "https://example.org/publication/fifth"));
    await ingest(publication("Publication without the distinguishing URL."));
    const ambiguous = await stored();
    expect(ambiguous).toHaveLength(6);
    expect(ambiguous.filter(({ text }) => text === null)).toHaveLength(2);
  } finally {
    await client.close();
  }
});

test.each(["ecli", "sheet-number"] as const)(
  "weak publication receives %s evidence without replacing a strong sibling",
  async (evidence) => {
    const client = await createTestPglite();
    const db = drizzle({
      client,
      relations: { ...relations, ...authRelationsPart },
    });
    const scopedDb: ScopedDb = async (callback) =>
      await db.transaction(async (tx) => await callback(asTestRaw(tx)));
    const sourceId = createSafeId<"caseLawSource">();
    const publication = (member?: string) =>
      plainTextIngestionResult({
        caseNumber: "104 C 16/2024",
        court: "Okresní soud v Chrudimi",
        country: "CZE",
        language: "cs",
        ecli:
          evidence === "ecli" && member
            ? `ECLI:CZ:OSCR:2025:104.C.16.2024.${member}`
            : undefined,
        sheetNumber: evidence === "sheet-number" ? member : undefined,
        fulltext: member ? `Výrok ${member}.` : "",
        rawHash: member ?? "listing",
        metadata: { publicationLabel: "stated publication" },
        documentAst: EMPTY_AST,
        textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
      });
    let observationOrder = 0n;
    const ingest = async (member?: string) => {
      const outcome = await processDecision({
        input: publication(member),
        scopedDb,
        sourceId,
        corpus,
        observationOrder: ++observationOrder,
        observedAt: new Date("2026-10-29T08:00:00Z"),
      });
      expect(outcome.status).toBe(PROCESS_DECISION_STATUS.COMPLETE);
    };
    const rows = async () =>
      await db
        .select({
          id: caseLawDecisions.id,
          text: caseLawDecisions.fulltext,
          strongKey: caseLawDecisions.fallbackIdentityKey,
        })
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.sourceId, sourceId));
    try {
      await db.insert(caseLawSources).values({
        id: sourceId,
        adapterKey: `evidence-${sourceId}`,
        name: "Evidence enrichment fixture",
      });
      await ingest();
      const original =
        (await rows()).at(0) ?? panic("Weak publication must be stored");
      await ingest("1");
      await ingest();
      const enriched = await rows();
      expect(enriched).toHaveLength(1);
      expect(enriched.at(0)?.id).toBe(original.id);
      expect(enriched.at(0)?.text).toBe("Výrok 1.");
      expect(enriched.at(0)?.strongKey).toContain("case-number:v2:");
      // The expansion keeps the previous index until the separate contract release.
      await db.execute(
        sql`DROP INDEX case_law_decisions_source_case_lang_null_idx`,
      );
      await ingest("2");
      await ingest("1");
      expect(await rows()).toHaveLength(2);
      expect((await rows()).find(({ id }) => id === original.id)?.text).toBe(
        "Výrok 1.",
      );
    } finally {
      await client.close();
    }
  },
);

test("sheet and normalized ECLI aliases enrich one row in both observation orders", async () => {
  const client = await createTestPglite();
  const db = drizzle({
    client,
    relations: { ...relations, ...authRelationsPart },
  });
  const scopedDb: ScopedDb = async (callback) =>
    await db.transaction(async (tx) => await callback(asTestRaw(tx)));
  const sourceId = createSafeId<"caseLawSource">();
  const publication = (
    ecli: string | undefined,
    sheetNumber: string | undefined,
  ) =>
    plainTextIngestionResult({
      caseNumber: "104 C 16/2024",
      court: "Okresní soud v Chrudimi",
      country: "CZE",
      language: "cs",
      decisionDate: "2025-04-18",
      ecli,
      sheetNumber,
      decisionType: "rozsudek",
      fulltext: "Výrok rozhodnutí.",
      rawHash: "same-source-envelope",
      metadata: {},
      documentAst: EMPTY_AST,
      textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
    });
  let observationOrder = 0n;
  const ingest = async (input: ReturnType<typeof publication>) => {
    const result = await processDecision({
      input,
      sourceId,
      scopedDb,
      corpus,
      observationOrder: ++observationOrder,
      observedAt: new Date("2026-10-29T08:00:00Z"),
    });
    expect(result.status).toBe(PROCESS_DECISION_STATUS.COMPLETE);
  };
  try {
    await db.insert(caseLawSources).values({
      id: sourceId,
      adapterKey: `strong-enrichment-${sourceId}`,
      name: "Strong enrichment fixture",
    });
    await ingest(publication(undefined, "28"));
    const original =
      (
        await db
          .select({ id: caseLawDecisions.id })
          .from(caseLawDecisions)
          .where(eq(caseLawDecisions.sourceId, sourceId))
      ).at(0) ?? panic("Sheet observation must be stored");
    await ingest(publication("ECLI:CZ:OSCR:2025:104.C.16.2024.1", "28"));
    await ingest(publication(undefined, "28"));
    await ingest(publication("ecli:cz:oscr:2025:104.c.16.2024.1", undefined));
    expect(
      await db
        .select({ id: caseLawDecisions.id })
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.sourceId, sourceId)),
    ).toEqual([original]);
    const aliases = await db
      .select({ decisionId: caseLawDecisionFallbackIdentities.decisionId })
      .from(caseLawDecisionFallbackIdentities)
      .where(eq(caseLawDecisionFallbackIdentities.sourceId, sourceId));
    expect(aliases).toHaveLength(2);
    expect(aliases.every(({ decisionId }) => decisionId === original.id)).toBe(
      true,
    );
  } finally {
    await client.close();
  }
});

test("legacy content proof adopts a corrected weak date on its original row", async () => {
  const client = await createTestPglite();
  const db = drizzle({
    client,
    relations: { ...relations, ...authRelationsPart },
  });
  const scopedDb: ScopedDb = async (callback) =>
    await db.transaction(async (tx) => await callback(asTestRaw(tx)));
  const sourceId = createSafeId<"caseLawSource">();
  const id = createSafeId<"caseLawDecision">();
  const input = plainTextIngestionResult({
    caseNumber: "0Pu/1/2025",
    court: "Mestský súd Košice",
    country: "SVK",
    language: "sk",
    decisionDate: "2025-05-28",
    decisionType: "uznesenie",
    fulltext: "Rovnaké uznesenie.",
    rawHash: "corrected-date",
    metadata: {},
    documentAst: EMPTY_AST,
    textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
  });
  try {
    await db.insert(caseLawSources).values({
      id: sourceId,
      adapterKey: `legacy-correction-${sourceId}`,
      name: "Legacy correction fixture",
    });
    await db.insert(caseLawDecisions).values({
      id,
      sourceId,
      caseNumber: input.caseNumber,
      court: input.court,
      country: input.country,
      language: input.language,
      decisionDate: "2025-04-18",
      fulltext: input.fulltext,
      contentHash: corpusContentHash(caseLawCanonicalPayload(input)),
    });
    const result = await processDecision({
      input,
      sourceId,
      scopedDb,
      corpus,
      observationOrder: 1n,
      observedAt: new Date("2026-10-29T08:00:00Z"),
    });
    expect(result.status).toBe(PROCESS_DECISION_STATUS.COMPLETE);
    expect(
      await db
        .select({ id: caseLawDecisions.id, day: caseLawDecisions.decisionDate })
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.sourceId, sourceId)),
    ).toEqual([{ id, day: "2025-05-28" }]);
  } finally {
    await client.close();
  }
});

test("legacy ECLI spelling changes adopt the original no-ID row", async () => {
  const client = await createTestPglite();
  const db = drizzle({
    client,
    relations: { ...relations, ...authRelationsPart },
  });
  const scopedDb: ScopedDb = async (callback) =>
    await db.transaction(async (tx) => await callback(asTestRaw(tx)));
  const sourceId = createSafeId<"caseLawSource">();
  const id = createSafeId<"caseLawDecision">();
  const input = plainTextIngestionResult({
    caseNumber: "104 C 16/2024",
    court: "Okresní soud v Chrudimi",
    country: "CZE",
    language: "cs",
    ecli: "ECLI:CZ:OSCR:2025:104.C.16.2024.1",
    decisionDate: "2025-05-28",
    fulltext: "Výrok rozhodnutí.",
    rawHash: "corrected-ecli",
    metadata: {},
    documentAst: EMPTY_AST,
    textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
  });
  try {
    await db.insert(caseLawSources).values({
      id: sourceId,
      adapterKey: `legacy-ecli-${sourceId}`,
      name: "Legacy ECLI fixture",
    });
    await db.insert(caseLawDecisions).values({
      id,
      sourceId,
      caseNumber: input.caseNumber,
      court: input.court,
      country: input.country,
      language: input.language,
      ecli: "ecli : cz : oscr : 2025 : 104.c.16.2024.1",
      fulltext: input.fulltext,
    });
    const result = await processDecision({
      input,
      sourceId,
      scopedDb,
      corpus,
      observationOrder: 1n,
      observedAt: new Date("2026-10-29T08:00:00Z"),
    });
    expect(result.status).toBe(PROCESS_DECISION_STATUS.COMPLETE);
    expect(
      await db
        .select({ id: caseLawDecisions.id })
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.sourceId, sourceId)),
    ).toEqual([{ id }]);
  } finally {
    await client.close();
  }
});
