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

import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import { stripHtml } from "@/api/handlers/case-law/ingestion/adapters/utils";
import { enterCaseLawMaintenanceLane } from "@/api/lib/case-law/maintenance-lane";
import { fetchWithTimeout } from "@/api/lib/fetch";
import { restrictOutboundUrl } from "@/api/lib/restrict-outbound-url";

// Hold the maintenance lane before the first statement: operator passes over
// the case-law tables serialize here instead of deadlocking on row locks.
const { rootDb } = await enterCaseLawMaintenanceLane();

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
  const target = restrictOutboundUrl({
    rawUrl: sourceUrl,
    hostPolicy: {
      type: "exact-origin",
      origins: ["https://rozhodnuti.nsoud.cz"],
    },
    pathPrefixes: ["/Judikatura/"],
  });
  if (target === null) {
    return undefined;
  }
  try {
    const response = await fetchWithTimeout(target, {
      redirect: "error",
      timeoutMs: 15_000,
    });
    if (!response.ok) {
      return undefined;
    }

    const html = await response.text();

    const parts = html.match(
      /<font[^>]*face="Times New Roman"[^>]*>(?:[\s\S]*?)<\/font>/giu,
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
  const idMatch = /\/(?<id>\d+)$/u.exec(documentUrl);
  if (!idMatch?.groups?.["id"]) {
    return undefined;
  }

  try {
    const response = await fetchWithTimeout(
      `https://vyhledavac.nssoud.cz/DokumentOriginal/Text/${idMatch.groups["id"]}`,
      { timeoutMs: 15_000 },
    );
    if (!response.ok) {
      return undefined;
    }

    const buffer = await response.arrayBuffer();
    const text = new TextDecoder("utf-16").decode(buffer);
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
  const [source] = await rootDb.transaction(
    async (tx) =>
      await tx
        .select({ id: caseLawSources.id })
        .from(caseLawSources)
        .where(eq(caseLawSources.adapterKey, config.adapterKey))
        .limit(1),
  );

  if (!source) {
    console.log(`[${config.adapterKey}] No source found, skipping`);
    return;
  }

  // Count missing
  const result = await rootDb.transaction(
    async (tx) =>
      await tx
        .select({ count: sql<number>`count(*)` })
        .from(caseLawDecisions)
        .where(
          sql`${caseLawDecisions.sourceId} = ${source.id}
              AND ${caseLawDecisions.fulltext} IS NULL`,
        ),
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
    // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- keyset page per iteration; the page is the batch
    const batch = await rootDb.transaction(
      async (tx) =>
        await tx
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
          .limit(BATCH_SIZE),
    );

    if (batch.length === 0) {
      break;
    }

    for (const row of batch) {
      const url =
        config.urlField === "source_url" ? row.sourceUrl : row.documentUrl;

      if (!url) {
        // No URL available — mark as empty to prevent re-query
        // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- one write per fetched row so progress survives a stop
        await rootDb.transaction(async (tx) => {
          await tx
            .update(caseLawDecisions)
            .set({ fulltext: "" })
            .where(eq(caseLawDecisions.id, row.id));
        });
        failed++;
        processed++;
        continue;
      }

      const fulltext = await config.fetchFulltext(url);

      // Always update the row — set empty string on failure so
      // the NULL check no longer matches and we don't re-query
      // this row forever.
      // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- one write per fetched row so progress survives a stop
      await rootDb.transaction(async (tx) => {
        await tx
          .update(caseLawDecisions)
          .set({ fulltext: fulltext ?? "" })
          .where(eq(caseLawDecisions.id, row.id));
      });

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
