/**
 * Seed the database with real decisions pulled from production for
 * local testing of the Case Law feature.
 *
 * Data lives in `__fixtures__/case-law/<adapterKey>.json` — one file per
 * source (cz-ns, cz-nss, cz-regional, cz-us, eu-ecj, pl-courts,
 * sk-courts, sk-us). Each fixture holds the source row plus the three
 * most recent decisions, taken verbatim from prod RDS so the dev DB
 * exercises the same shape (sections, document_ast, fulltext, metadata)
 * the readers and AI pipeline see in production.
 *
 * Prerequisites:
 *   Run seed-test-user.ts first to create the test organization.
 *
 * Usage:
 *   bun apps/api/scripts/seed-case-law.ts
 */

import { and, eq, sql } from "drizzle-orm";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import * as v from "valibot";

import type { PersistedDecisionAnalysis } from "@stll/case-law/analysis";
import type { DocumentAst } from "@stll/case-law/document-ast";

import { createScopedDb } from "@/api/db";
import { db } from "@/api/db/root";
import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import type { EmptyAst } from "@/api/handlers/case-law/ingestion/adapter";
import { indexDecision } from "@/api/handlers/case-law/search-index";
import type { DecisionSection } from "@/api/handlers/case-law/types";
import { toSafeId } from "@/api/lib/branded-types";

import { DEFAULT_ORG_ID, DEFAULT_USER_ID, seedId } from "./seed-utils";

const FIXTURES_DIR = join(import.meta.dir, "__fixtures__", "case-law");

const sourceIdFor = (adapterKey: string) =>
  seedId(`case-law-source-${adapterKey}`);
const decisionIdFor = (
  adapterKey: string,
  caseNumber: string,
  language: string,
) => seedId(`case-law-dec-${adapterKey}-${caseNumber}-${language}`);

type FixtureSource = {
  adapter_key: string;
  name: string;
  enabled: boolean;
  config: Record<string, unknown> | null;
};

type FixtureDecision = {
  case_number: string;
  slug: string | null;
  ecli: string | null;
  court: string;
  country: string;
  language: string;
  language_group_key: string | null;
  decision_date: string | null;
  decision_type: string | null;
  fulltext: string | null;
  sections: DecisionSection[] | null;
  document_ast: DocumentAst | EmptyAst | null;
  analysis: PersistedDecisionAnalysis | null;
  parser_version: number | null;
  source_raw: string | null;
  source_raw_s3_key: string | null;
  source_raw_content_type: string | null;
  source_url: string | null;
  document_url: string | null;
  metadata: Record<string, unknown> | null;
  source_hash: string | null;
};

type CaseLawFixture = {
  source: FixtureSource;
  decisions: FixtureDecision[];
};

// Minimal structural schema so a malformed fixture (missing source,
// decisions not an array, missing case_number / language used to
// derive seed IDs) fails fast with a useful path. Inner JSON fields
// (sections, document_ast, analysis, metadata) are checked into the
// repo and trusted by downstream `as` narrowing.
const fixtureSchema = v.looseObject({
  source: v.looseObject({
    adapter_key: v.string(),
    name: v.string(),
    enabled: v.boolean(),
  }),
  decisions: v.array(
    v.looseObject({
      case_number: v.string(),
      language: v.string(),
    }),
  ),
});

const loadFixtures = async (): Promise<CaseLawFixture[]> => {
  const entries = await readdir(FIXTURES_DIR);
  const fixtures: CaseLawFixture[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    const file = Bun.file(join(FIXTURES_DIR, entry));
    const raw = v.parse(fixtureSchema, await file.json());
    // SAFETY: structural fields validated by fixtureSchema; deep JSON
    // (sections, document_ast, analysis) is checked into the repo
    // and matches the prod schema by construction.
    // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    fixtures.push(raw as CaseLawFixture);
  }
  fixtures.sort((a, b) =>
    a.source.adapter_key.localeCompare(b.source.adapter_key),
  );
  return fixtures;
};

const ensureSearchPreviewConfig = async () => {
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS unaccent`);
  await db.execute(sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_ts_config
        WHERE cfgname = 'stella_unaccent'
          AND cfgnamespace = 'public'::regnamespace
      ) THEN
        CREATE TEXT SEARCH CONFIGURATION public.stella_unaccent (COPY = pg_catalog.simple);
      END IF;
    END
    $$;
  `);
  await db.execute(sql`
    ALTER TEXT SEARCH CONFIGURATION public.stella_unaccent
      ALTER MAPPING FOR
        asciiword,
        asciihword,
        hword_asciipart,
        word,
        hword,
        hword_part
      WITH unaccent, simple
  `);
};

export async function seedCaseLaw() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to run: NODE_ENV must not be 'production'.");
  }

  const scopedDb = createScopedDb(
    db,
    [],
    DEFAULT_ORG_ID,
    toSafeId<"user">(DEFAULT_USER_ID),
  );

  await ensureSearchPreviewConfig();

  const fixtures = await loadFixtures();
  console.log(`Found ${fixtures.length} fixtures.`);

  let totalDecisions = 0;
  let totalInserted = 0;

  for (const { source, decisions } of fixtures) {
    const adapterKey = source.adapter_key;

    const findSourceId = () =>
      db.query.caseLawSources.findFirst({
        where: { adapterKey: { eq: adapterKey } },
        columns: { id: true },
      });

    const existingSource = await findSourceId();
    let sourceId = existingSource?.id;
    if (!sourceId) {
      const inserted = await db
        .insert(caseLawSources)
        .values({
          id: sourceIdFor(adapterKey),
          adapterKey,
          name: source.name,
          enabled: source.enabled,
          lastSyncAt: new Date(),
          config: source.config ?? {},
        })
        .onConflictDoNothing()
        .returning({ id: caseLawSources.id });

      // If the insert raced with another writer (e.g. ingestion),
      // it returns no rows and the actual source id is whatever
      // that writer set. Re-read so we don't FK-violate against a
      // deterministic id that does not match what's on disk.
      sourceId = inserted.at(0)?.id ?? (await findSourceId())?.id;
      if (!sourceId) {
        throw new Error(`Could not resolve source id for ${adapterKey}`);
      }
    }

    let inserted = 0;
    for (const d of decisions) {
      const id = decisionIdFor(adapterKey, d.case_number, d.language);
      const fulltext =
        d.fulltext ?? d.sections?.map((s) => s.text).join("\n\n") ?? "";

      const result = await db
        .insert(caseLawDecisions)
        .values({
          id,
          sourceId,
          caseNumber: d.case_number,
          slug: d.slug,
          ecli: d.ecli,
          court: d.court,
          country: d.country,
          language: d.language,
          languageGroupKey: d.language_group_key,
          decisionDate: d.decision_date,
          decisionType: d.decision_type,
          fulltext,
          sections: d.sections,
          documentAst: d.document_ast,
          analysis: d.analysis,
          parserVersion: d.parser_version ?? 0,
          sourceRaw: d.source_raw,
          sourceRawS3Key: d.source_raw_s3_key,
          sourceRawContentType: d.source_raw_content_type,
          sourceUrl: d.source_url,
          documentUrl: d.document_url,
          metadata: d.metadata ?? {},
          sourceHash: d.source_hash,
        })
        .onConflictDoNothing()
        .returning({ id: caseLawDecisions.id });

      // On conflict the insert returns no rows and the existing row
      // id is whatever the prior writer chose, not our deterministic
      // seed id. Re-query by the unique key so indexDecision targets
      // the actual row.
      let decisionId = result.at(0)?.id;
      if (!decisionId) {
        const existing = await db
          .select({ id: caseLawDecisions.id })
          .from(caseLawDecisions)
          .where(
            and(
              eq(caseLawDecisions.sourceId, sourceId),
              eq(caseLawDecisions.caseNumber, d.case_number),
              eq(caseLawDecisions.language, d.language),
            ),
          )
          .limit(1);
        decisionId = existing.at(0)?.id;
      }
      if (!decisionId) {
        throw new Error(
          `Could not resolve decision id for ${adapterKey} ${d.case_number} ${d.language}`,
        );
      }

      await indexDecision(decisionId, scopedDb);

      if (result.length > 0) {
        inserted++;
      }
    }

    totalDecisions += decisions.length;
    totalInserted += inserted;
    console.log(
      `  ${adapterKey.padEnd(12)} ${inserted}/${decisions.length} inserted (${existingSource ? "reused source" : "created source"})`,
    );
  }

  console.log(
    `\nDecisions: ${totalInserted} inserted, ${totalDecisions - totalInserted} skipped.`,
  );
  console.log("Done. Case law data seeded successfully.");
}

if (import.meta.main) {
  seedCaseLaw()
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      console.error("Seed failed:", error);
      process.exit(1);
    });
}
