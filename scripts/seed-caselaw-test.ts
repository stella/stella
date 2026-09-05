/**
 * Seed the test DB with a handful of Czech Supreme Court
 * decisions by fetching their WebPrint HTML and parsing.
 *
 * Usage: bun run scripts/seed-caselaw-test.ts
 */

import { panic } from "better-result";

import { parseNsDecisionHtml } from "../apps/api/src/handlers/case-law/ingestion/parsers/cz-ns";
import { ADAPTER_KEYS } from "../apps/api/src/lib/legal-search/ingestion-constants";

const db = new Bun.SQL({
  hostname: "localhost",
  port: 5432,
  database: "stella",
  username: "postgres",
  password: "postgres",
});

const BASE = "https://rozhodnuti.nsoud.cz/Judikatura/judikatura_ns.nsf";

// `case_law_sources.id` is a uuid column, so the previous `'test_cz_ns'` could
// never have inserted. Fixed rather than generated so re-running the seed
// converges on one row instead of accumulating them.
const SOURCE_ID = "00000000-0000-4000-8000-0000000c2f51";

// A set of diverse decisions to test rendering
const UNIDS = [
  "00053131A0026262C125819F00262FF8", // 23 Nd 480/2024
  "00007CCB5DBCB0F0C1257F6F00369EAE", // 23 Cdo 3470/2015
  "00036A17CD475891C1257F850030A984", // 28 Cdo 3959/2014
  "00024C464B55E75DC1258BF70052AA95", // 6 Tdo 647/2017
  "00038EC6F9D76E31C1257A4E0065A3CE", // 29 Odo 975/2006
  "CBD000CC5A2294DEC1257E46001ABDE7", // 3 Tdo 232/2015
  "00029DA14F35D34DC1257E7E003B3E2B", // 22 Cdo 1772/2010
  "0003BDD58DB9C50AC1257BDB0027B5D0", // 29 ICdo 37/2013
  "0002D100CD109B7DC12585D0002D23E2", // 22 Cdo 895/2020
  "000342F8ACB64C62C125867E0037C65C", // 21 Cdo 4994/2007
];

const generateId = (): string => crypto.randomUUID();

const slugify = (caseNumber: string): string =>
  caseNumber
    .toLowerCase()
    .replace(/\//gu, "-")
    .replace(/\s+/gu, "-")
    .replace(/[^a-z0-9-]/gu, "");

const fetchHtml = async (url: string): Promise<string | null> => {
  try {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(15_000),
    });
    return r.ok ? await r.text() : null;
  } catch {
    return null;
  }
};

const main = async () => {
  // Ensure the source row exists. The adapter key comes from the registry
  // rather than a literal because this row stands for a real adapter and
  // should say so: the operational views resolve each source's key against the
  // registry, and an invented one would be reported as unrecognized.
  //
  // The id comes back from the upsert rather than being assumed: `adapter_key`
  // is unique, so if this key already exists under a different id (an earlier
  // seed, a real ingestion run) the insert is skipped and SOURCE_ID identifies
  // nothing. Decisions inserted against it would fail their source FK. The
  // no-op `DO UPDATE` is what makes the row return its id either way.
  const [source] = await db`
    INSERT INTO case_law_sources (id, adapter_key, name)
    VALUES (${SOURCE_ID}, ${ADAPTER_KEYS.CZ_NS}, 'Czech Supreme Court (test)')
    ON CONFLICT (adapter_key) DO UPDATE SET adapter_key = EXCLUDED.adapter_key
    RETURNING id
  `;
  const sourceId: string =
    source?.id ?? panic("case_law_sources upsert returned no id");

  let success = 0;

  for (const [i, unid] of UNIDS.entries()) {
    const webUrl = `${BASE}/WebSearch/${unid}?openDocument`;
    const printUrl = `${BASE}/WebPrint/${unid}?openDocument`;

    // Crawled one decision at a time on purpose; the sleep below rate-limits it.
    const [webHtml, printHtml] = await Promise.all([
      fetchHtml(webUrl),
      fetchHtml(printUrl),
    ]);

    if (!printHtml) {
      console.warn(`[${i + 1}] SKIP ${unid}: no print page`);
      continue;
    }

    const result = parseNsDecisionHtml({
      documentId: unid,
      webUrl,
      printUrl,
      webHtml: webHtml ?? "",
      printHtml,
    });

    const meta = result.metadata;
    const caseNumber = meta.caseNumber ?? `unknown-${unid}`;
    const slug = slugify(caseNumber);
    const id = generateId();

    // Bun SQL double-encodes JSONB params. Use a
    // two-step approach: insert row, then update JSONB.
    await db`
      INSERT INTO case_law_decisions (
        id, source_id, case_number, slug, ecli, court,
        country, language, decision_date, decision_type,
        fulltext, source_url
      ) VALUES (
        ${id}, ${sourceId}, ${caseNumber}, ${slug},
        ${meta.ecli}, ${meta.court ?? "Nejvyšší soud"},
        'CZE', 'cs', ${meta.decisionDate},
        ${meta.decisionType?.toLowerCase() ?? null},
        ${result.fulltext}, ${webUrl}
      )
      ON CONFLICT (source_id, case_number, language)
      DO UPDATE SET fulltext = EXCLUDED.fulltext
    `;

    // Update JSONB columns via raw SQL. The casts go through text: a bare
    // `$n::jsonb` pins the parameter's type to jsonb, so the driver encodes
    // these already-serialized strings again and the column ends up holding a
    // jsonb string instead of the object.
    const astStr = JSON.stringify(result.documentAst);
    const metaStr = JSON.stringify(result.sourceMetadata);
    await db.unsafe(
      `UPDATE case_law_decisions
       SET document_ast = $1::text::jsonb,
           metadata = $2::text::jsonb
       WHERE case_number = $3 AND language = 'cs'`,
      [astStr, metaStr, caseNumber],
    );

    console.log(
      `[${i + 1}/${UNIDS.length}] ${caseNumber} ✓ (${result.documentAst.blocks.length} blocks)`,
    );
    success++;

    if (i < UNIDS.length - 1) {
      await Bun.sleep(300);
    }
  }

  console.log(`\nDone: ${success} seeded`);
  process.exit(0);
};

main().catch((error: unknown) => {
  console.error("Fatal:", error);
  process.exit(1);
});
