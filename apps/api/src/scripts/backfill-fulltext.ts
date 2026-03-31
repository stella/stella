/**
 * Backfill fulltext for decisions that were ingested without it.
 *
 * Queries decisions where fulltext IS NULL, fetches the text from
 * the source, and updates the row. Processes in batches with rate
 * limiting.
 *
 * Usage:
 *   bun apps/api/src/scripts/backfill-fulltext.ts
 */

import { eq, sql } from "drizzle-orm";

import { db } from "@/api/db";
import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import { stripHtml } from "@/api/handlers/case-law/ingestion/adapters/utils";

const BATCH_SIZE = 50;

// ── CZ Supreme Court ────────────────────────────────────

const BODY_START_MARKERS = [
  "Nejvyšší soud rozhodl",
  "Nejvyšší soud České republiky",
  "Nejvyšší soud projednal",
];

const fetchCzSupremeFulltext = async (
  sourceUrl: string,
): Promise<string | undefined> => {
  try {
    const response = await fetch(sourceUrl, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      return undefined;
    }

    const html = await response.text();

    const parts = html.match(
      /<font[^>]*face="Times New Roman"[^>]*>([\s\S]*?)<\/font>/gi,
    );
    if (!parts || parts.length === 0) {
      return undefined;
    }

    let text = stripHtml(parts.join(" ")).trim();

    for (const marker of BODY_START_MARKERS) {
      const pos = text.indexOf(marker);
      if (pos > 0) {
        text = text.slice(pos);
        break;
      }
    }

    const endPos = text.indexOf("Citace rozhodnutí");
    if (endPos > 0) {
      text = text.slice(0, endPos).trim();
    }

    return text.length > 100 ? text : undefined;
  } catch {
    return undefined;
  }
};

// ── CZ Supreme Administrative Court ─────────────────────

const fetchCzSupremeAdminFulltext = async (
  documentUrl: string,
): Promise<string | undefined> => {
  // Extract document ID from URL like .../DokumentDetail/Index/744029
  const idMatch = documentUrl.match(/\/(\d+)$/);
  if (!idMatch?.[1]) {
    return undefined;
  }

  try {
    const response = await fetch(
      `https://vyhledavac.nssoud.cz/DokumentOriginal/Text/${idMatch[1]}`,
      { signal: AbortSignal.timeout(15_000) },
    );
    if (!response.ok) {
      return undefined;
    }

    const buffer = await response.arrayBuffer();
    const text = new TextDecoder("utf-16le").decode(buffer);
    const body = stripHtml(text);
    return body.length > 100 ? body : undefined;
  } catch {
    return undefined;
  }
};

// ── Main ────────────────────────────────────────────────

type BackfillConfig = {
  adapterKey: string;
  fetchFulltext: (url: string) => Promise<string | undefined>;
  urlField: "source_url" | "document_url";
  delayMs: number;
};

const CONFIGS: BackfillConfig[] = [
  {
    adapterKey: ADAPTER_KEYS.CZ_NS,
    fetchFulltext: fetchCzSupremeFulltext,
    urlField: "source_url",
    delayMs: 300,
  },
  {
    adapterKey: ADAPTER_KEYS.CZ_NSS,
    fetchFulltext: fetchCzSupremeAdminFulltext,
    urlField: "document_url",
    delayMs: 500,
  },
];

const backfillAdapter = async (config: BackfillConfig) => {
  // Get source ID
  const [source] = await db
    .select({ id: caseLawSources.id })
    .from(caseLawSources)
    .where(eq(caseLawSources.adapterKey, config.adapterKey))
    .limit(1);

  if (!source) {
    console.log(`[${config.adapterKey}] No source found, skipping`);
    return;
  }

  // Count missing
  const result = await db
    .select({ count: sql<number>`count(*)` })
    .from(caseLawDecisions)
    .where(
      sql`${caseLawDecisions.sourceId} = ${source.id}
          AND ${caseLawDecisions.fulltext} IS NULL`,
    );

  const count = result.at(0)?.count ?? 0;
  console.log(`[${config.adapterKey}] ${count} decisions missing fulltext`);
  if (count === 0) {
    return;
  }

  let processed = 0;
  let filled = 0;
  let failed = 0;

  while (true) {
    const batch = await db
      .select({
        id: caseLawDecisions.id,
        sourceUrl: caseLawDecisions.sourceUrl,
        documentUrl: caseLawDecisions.documentUrl,
        caseNumber: caseLawDecisions.caseNumber,
      })
      .from(caseLawDecisions)
      .where(
        sql`${caseLawDecisions.sourceId} = ${source.id}
            AND ${caseLawDecisions.fulltext} IS NULL`,
      )
      .limit(BATCH_SIZE);

    if (batch.length === 0) {
      break;
    }

    for (const row of batch) {
      const url =
        config.urlField === "source_url" ? row.sourceUrl : row.documentUrl;

      if (!url) {
        // No URL available — mark as empty to prevent re-query
        await db
          .update(caseLawDecisions)
          .set({ fulltext: "" })
          .where(eq(caseLawDecisions.id, row.id));
        failed++;
        processed++;
        continue;
      }

      const fulltext = await config.fetchFulltext(url);

      // Always update the row — set empty string on failure so
      // the NULL check no longer matches and we don't re-query
      // this row forever.
      await db
        .update(caseLawDecisions)
        .set({ fulltext: fulltext ?? "" })
        .where(eq(caseLawDecisions.id, row.id));

      if (fulltext) {
        filled++;
      } else {
        failed++;
      }

      processed++;

      if (processed % 100 === 0) {
        console.log(
          `[${config.adapterKey}] ${processed}/${count} ` +
            `(${filled} filled, ${failed} failed)`,
        );
      }

      await Bun.sleep(config.delayMs);
    }
  }

  console.log(
    `[${config.adapterKey}] Done: ${filled} filled, ${failed} failed ` +
      `out of ${processed}`,
  );
};

console.log("Starting fulltext backfill...\n");

for (const config of CONFIGS) {
  await backfillAdapter(config);
  console.log();
}

console.log("Backfill complete.");
process.exit(0);
