/**
 * Re-ingest case law decisions: fetch WebPrint HTML from
 * rozhodnuti.nsoud.cz and parse into DocumentAst.
 *
 * Usage: bun run scripts/reingest-caselaw-ast.ts
 *
 * Reads existing decisions from the DB, fetches the print
 * page for each, runs the cz-ns parser, and updates the
 * document_ast and fulltext columns.
 */

import { parseNsDecisionHtml } from "../apps/api/src/handlers/case-law/ingestion/parsers/cz-ns";

const db = new Bun.SQL({
  hostname: "localhost",
  port: 5432,
  database: "stella_caselaw_test",
  username: "postgres",
  password: "postgres",
});

const BASE_URL =
  "https://rozhodnuti.nsoud.cz/Judikatura/judikatura_ns.nsf";

type DecisionRow = {
  id: string;
  case_number: string;
  source_url: string | null;
};

const extractUnid = (url: string): string | null => {
  const match = url.match(/WebSearch\/([A-F0-9]+)/i);
  return match?.[1] ?? null;
};

const fetchHtml = async (
  url: string,
  signal: AbortSignal,
): Promise<string | null> => {
  try {
    const response = await fetch(url, { signal });
    if (!response.ok) {return null;}
    return await response.text();
  } catch {
    return null;
  }
};

const main = async () => {
  const rows: DecisionRow[] = await db`
    SELECT id, case_number, source_url
    FROM case_law_decisions
    WHERE source_url IS NOT NULL
    ORDER BY created_at DESC
  `;

  console.log(`Found ${rows.length} decisions to process`);

  let success = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const unid = row.source_url
      ? extractUnid(row.source_url)
      : null;

    if (!unid) {
      skipped++;
      continue;
    }

    const webUrl = `${BASE_URL}/WebSearch/${unid}?openDocument`;
    const printUrl = `${BASE_URL}/WebPrint/${unid}?openDocument`;

    const signal = AbortSignal.timeout(15_000);

    const [webHtml, printHtml] = await Promise.all([
      fetchHtml(webUrl, signal),
      fetchHtml(printUrl, signal),
    ]);

    if (!printHtml) {
      console.warn(
        `[${i + 1}/${rows.length}] SKIP ${row.case_number}: no print page`,
      );
      skipped++;
      continue;
    }

    try {
      const result = parseNsDecisionHtml({
        documentId: unid,
        webUrl,
        printUrl,
        webHtml: webHtml ?? "",
        printHtml,
      });

      const astJson = JSON.stringify(result.documentAst);
      const metaJson = JSON.stringify(result.sourceMetadata);
      await db`
        UPDATE case_law_decisions
        SET
          document_ast = ${astJson}::jsonb,
          fulltext = ${result.fulltext},
          metadata = metadata || ${metaJson}::jsonb
        WHERE id = ${row.id}
      `;

      success++;
      if ((i + 1) % 10 === 0 || i === rows.length - 1) {
        console.log(
          `[${i + 1}/${rows.length}] ${row.case_number} ✓ (${result.documentAst.blocks.length} blocks)`,
        );
      }
    } catch (error) {
      failed++;
      console.error(
        `[${i + 1}/${rows.length}] FAIL ${row.case_number}:`,
        error instanceof Error ? error.message : error,
      );
    }

    // Rate limit
    if (i < rows.length - 1) {
      await Bun.sleep(300);
    }
  }

  console.log(
    `\nDone: ${success} success, ${skipped} skipped, ${failed} failed`,
  );
  process.exit(0);
};

main().catch((error) => {
  console.error("Fatal:", error);
  process.exit(1);
});
