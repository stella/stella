import { and, eq, gt, sql } from "drizzle-orm";

import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import {
  ECJ_LISTING_TIMEOUT_MS,
  listCelexVariants,
} from "@/api/handlers/case-law/ingestion/adapters/eu-ecj";
import type { SafeId } from "@/api/lib/branded-types";
import { openCaseLawReadOnlySession } from "@/api/lib/case-law/maintenance-lane";

/**
 * Classify every stored eu-ecj decision against Cellar's own listing.
 *
 * The stored corpus predates the CJEU parser and part of it was fetched from
 * a source that returned page furniture for language variants that were
 * never published. Cellar's SPARQL is the authority on which
 * (CELEX, language) pairs exist as XHTML, so each stored row lands in one
 * of four buckets:
 *
 *   refetchable    the variant exists; a re-fetch replaces the row
 *   phantom        the CELEX is listed but not in this language; the row
 *                  describes a document that was never published
 *   celexUnlisted  Cellar lists nothing for the CELEX under the crawl's
 *                  type and manifestation filters; not proof of a phantom —
 *                  the work may exist outside those filters
 *   missingCelex   the row carries no CELEX; nothing can be asked
 *
 * Reads row identity and metadata only (no fulltext columns), in keyset
 * pages, so it stays cheap on a busy instance. Writes nothing anywhere; the
 * report file feeds the re-fetch runner.
 *
 *   bun run src/scripts/eu-ecj-census.ts --out eu-ecj-census.json
 */

const DEFAULT_PAGE_SIZE = 500;
const DEFAULT_SPARQL_CHUNK = 100;
/** Politeness pause between SPARQL queries; this is a bulk read. */
const SPARQL_DELAY_MS = 1000;

const USAGE = `Usage: bun run src/scripts/eu-ecj-census.ts [options]

  --out <path>         Report file (default eu-ecj-census.json).
  --page-size <n>      Rows read per database query (default ${DEFAULT_PAGE_SIZE}).
  --sparql-chunk <n>   CELEX numbers per SPARQL query (default ${DEFAULT_SPARQL_CHUNK}).`;

const flagValue = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) {
    return undefined;
  }
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    console.error(`--${name} requires a value`);
    console.error(USAGE);
    process.exit(1);
  }
  return value;
};

const DECIMAL_INTEGER = /^\d+$/u;

const positiveInteger = (
  raw: string | undefined,
  fallback: number,
  name: string,
): number => {
  if (raw === undefined) {
    return fallback;
  }
  const parsed = DECIMAL_INTEGER.test(raw)
    ? Number.parseInt(raw, 10)
    : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    console.error(`--${name} must be a positive integer, got: ${raw}`);
    process.exit(1);
  }
  return parsed;
};

/**
 * The SPARQL endpoint caps responses at 10,000 bindings and a truncated
 * targeted listing now throws; up to 24 languages with occasional
 * re-published manifestations per pair keeps 300 CELEX safely under it.
 */
const MAX_SPARQL_CHUNK = 300;

const outPath = flagValue("out") ?? "eu-ecj-census.json";
const pageSize = positiveInteger(
  flagValue("page-size"),
  DEFAULT_PAGE_SIZE,
  "page-size",
);
const sparqlChunk = Math.min(
  positiveInteger(
    flagValue("sparql-chunk"),
    DEFAULT_SPARQL_CHUNK,
    "sparql-chunk",
  ),
  MAX_SPARQL_CHUNK,
);

// This tool only reads; the read-only session makes that a property of every
// transaction rather than a promise, and takes no maintenance lane.
const { ingestionDb } = await openCaseLawReadOnlySession();

const source = (
  await ingestionDb((tx) =>
    tx
      .select({ id: caseLawSources.id })
      .from(caseLawSources)
      .where(eq(caseLawSources.adapterKey, ADAPTER_KEYS.EU_ECJ))
      .limit(1),
  )
).at(0);
if (!source) {
  console.error("No case-law source configured for adapter eu-ecj");
  process.exit(1);
}

type CensusRow = {
  id: SafeId<"caseLawDecision">;
  language: string;
  celex: string | null;
};

// The explicit return type breaks the inference cycle the keyset loop
// otherwise creates: the boundary feeds the query whose result feeds the
// next boundary.
const selectCensusPage = async (
  boundary: SafeId<"caseLawDecision"> | null,
): Promise<CensusRow[]> =>
  await ingestionDb((tx) =>
    tx
      .select({
        id: caseLawDecisions.id,
        language: caseLawDecisions.language,
        celex: sql<string | null>`${caseLawDecisions.metadata}->>'celex'`,
      })
      .from(caseLawDecisions)
      .where(
        boundary === null
          ? eq(caseLawDecisions.sourceId, source.id)
          : and(
              eq(caseLawDecisions.sourceId, source.id),
              gt(caseLawDecisions.id, boundary),
            ),
      )
      .orderBy(caseLawDecisions.id)
      .limit(pageSize),
  );

const rows: CensusRow[] = [];
let after: SafeId<"caseLawDecision"> | null = null;
for (;;) {
  const page = await selectCensusPage(after);
  rows.push(...page);
  const last = page.at(-1);
  if (page.length < pageSize || !last) {
    break;
  }
  after = last.id;
  console.error(`read ${rows.length} rows…`);
}
console.error(`stored rows: ${rows.length}`);

const missingCelex = rows.filter((row) => row.celex === null);
const withCelex = rows.filter(
  (row): row is CensusRow & { celex: string } => row.celex !== null,
);
const distinctCelex = [...new Set(withCelex.map((row) => row.celex))].sort();
console.error(`distinct CELEX: ${distinctCelex.length}`);

/** `celex:LANG` pairs Cellar lists as existing XHTML manifestations. */
const listedVariants = new Set<string>();
const listedCelex = new Set<string>();
for (let index = 0; index < distinctCelex.length; index += sparqlChunk) {
  const chunk = distinctCelex.slice(index, index + sparqlChunk);
  const variants = await listCelexVariants({
    celexNumbers: chunk,
    signal: AbortSignal.timeout(ECJ_LISTING_TIMEOUT_MS),
  });
  for (const variant of variants) {
    listedVariants.add(`${variant.celex}:${variant.language}`);
    listedCelex.add(variant.celex);
  }
  console.error(
    `queried ${Math.min(index + sparqlChunk, distinctCelex.length)} of ${distinctCelex.length} CELEX…`,
  );
  await Bun.sleep(SPARQL_DELAY_MS);
}

const refetchable: (CensusRow & { celex: string })[] = [];
const phantoms: (CensusRow & { celex: string })[] = [];
const celexUnlisted: (CensusRow & { celex: string })[] = [];
for (const row of withCelex) {
  if (listedVariants.has(`${row.celex}:${row.language.toUpperCase()}`)) {
    refetchable.push(row);
  } else if (listedCelex.has(row.celex)) {
    phantoms.push(row);
  } else {
    celexUnlisted.push(row);
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  counts: {
    rows: rows.length,
    distinctCelex: distinctCelex.length,
    refetchable: refetchable.length,
    phantoms: phantoms.length,
    celexUnlisted: celexUnlisted.length,
    missingCelex: missingCelex.length,
  },
  refetchableCelex: [...new Set(refetchable.map((row) => row.celex))].sort(),
  phantoms,
  celexUnlisted,
  missingCelex: missingCelex.map(({ id, language }) => ({ id, language })),
};

await Bun.write(outPath, `${JSON.stringify(report, null, 2)}\n`);
console.error(`report written to ${outPath}`);
console.log(JSON.stringify(report.counts, null, 2));
process.exit(0);
