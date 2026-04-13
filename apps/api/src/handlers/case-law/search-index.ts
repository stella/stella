import { eq, sql } from "drizzle-orm";

import type { ScopedDb } from "@/api/db";
import { caseLawSearchDocuments } from "@/api/db/schema";
import { resolveFtsConfig } from "@/api/handlers/case-law/fts-config";

import type { DecisionSection } from "./types";

const sectionsToPlainText = (sections: DecisionSection[] | null): string =>
  sections?.map((s) => s.text).join(" ") ?? "";

/**
 * Upsert a decision into the `case_law_search_documents` table,
 * computing the tsvector with the language-appropriate regconfig
 * from the `case_law_fts_configs` table.
 *
 * Mirrors the pattern from `lib/search/index-entity.ts` but
 * operates on the global (no tenant column) search table.
 */
export const indexDecision = async (
  decisionId: string,
  scopedDb: ScopedDb,
): Promise<void> => {
  const decision = await scopedDb((tx) =>
    tx.query.caseLawDecisions.findFirst({
      where: { id: decisionId },
      columns: {
        id: true,
        caseNumber: true,
        ecli: true,
        court: true,
        language: true,
        fulltext: true,
        sections: true,
      },
    }),
  );

  if (!decision) {
    return;
  }

  const title = `${decision.caseNumber} — ${decision.court}`;
  const bodyText =
    decision.fulltext ??
    // SAFETY: sections is typed as unknown in Drizzle's JSONB
    // column but is always DecisionSection[] | null when set
    // by the ingestion pipeline (segmenter.ts).
    sectionsToPlainText(decision.sections);

  const searchableText = [
    decision.caseNumber,
    decision.ecli,
    decision.court,
    bodyText,
  ]
    .filter(Boolean)
    .join(" ");

  const fts = await resolveFtsConfig(decision.language);

  const textExpr = fts.useUnaccent
    ? sql`unaccent(coalesce(${title}, '') || ' ' || coalesce(${searchableText}, ''))`
    : sql`coalesce(${title}, '') || ' ' || coalesce(${searchableText}, '')`;

  const tsvExpr = sql`to_tsvector('simple', ${textExpr})`;

  await scopedDb((tx) =>
    tx.execute(sql`
    INSERT INTO case_law_search_documents (
      decision_id, title, searchable_text,
      language, regconfig, updated_at, tsv
    ) VALUES (
      ${decision.id},
      ${title},
      ${searchableText},
      ${decision.language},
      ${"simple"},
      now(),
      ${tsvExpr}
    )
    ON CONFLICT (decision_id) DO UPDATE SET
      title = EXCLUDED.title,
      searchable_text = EXCLUDED.searchable_text,
      language = EXCLUDED.language,
      regconfig = EXCLUDED.regconfig,
      updated_at = EXCLUDED.updated_at,
      tsv = EXCLUDED.tsv
  `),
  );
};

/**
 * Remove a decision from the search index.
 * Normally handled by CASCADE FK, but useful for
 * explicit cleanup.
 */
export const removeDecisionFromIndex = async (
  decisionId: string,
  scopedDb: ScopedDb,
): Promise<void> => {
  await scopedDb((tx) =>
    tx
      .delete(caseLawSearchDocuments)
      .where(eq(caseLawSearchDocuments.decisionId, decisionId)),
  );
};
