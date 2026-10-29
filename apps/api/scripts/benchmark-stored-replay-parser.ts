/**
 * Parser-only lower bound: committed stored-raw fixtures, no database or S3.
 *
 * Run from apps/api:
 * bun --preload ./src/tests/setup-env.ts scripts/benchmark-stored-replay-parser.ts
 *
 * Repetitions are stated separately from distinct fixture rows. These samples
 * do not estimate corpus-wide quantiles, database writes, or admission duty.
 */
import { panic } from "better-result";
import * as v from "valibot";

import type { StoredRawReparseInput } from "@/api/handlers/case-law/ingestion/adapter";
import { czNssAdapter } from "@/api/handlers/case-law/ingestion/adapters/cz-nss";
import { plSnAdapter } from "@/api/handlers/case-law/ingestion/adapters/pl-sn";
import { skCourtsAdapter } from "@/api/handlers/case-law/ingestion/adapters/sk-courts";
import { readGzipJson } from "@/api/lib/gzip-json";

const SAMPLE_COUNT = 250;
const WARMUP_COUNT = 10;
const storedRowSchema = v.object({
  caseNumber: v.string(),
  sourceDocumentId: v.optional(v.string()),
  language: v.string(),
  court: v.string(),
  ecli: v.optional(v.string()),
  decisionDate: v.optional(v.string()),
  decisionType: v.optional(v.string()),
  sourceUrl: v.optional(v.string()),
  documentUrl: v.optional(v.string()),
  metadata: v.record(v.string(), v.unknown()),
  sourceRaw: v.string(),
  sourceRawContentType: v.optional(v.string()),
});
const capturedPageSchema = v.object({
  page: v.object({ decisions: v.array(storedRowSchema) }),
});

const adapterRoot = new URL(
  "../src/handlers/case-law/ingestion/adapters/__fixtures__/",
  import.meta.url,
);
const parserRoot = new URL(
  "../src/handlers/case-law/ingestion/parsers/__fixtures__/",
  import.meta.url,
);

const capturedRows = async (name: string) => {
  const captured = v.parse(
    capturedPageSchema,
    await readGzipJson(new URL(name, adapterRoot)),
  );
  return captured.page.decisions.map(
    (row) =>
      ({
        raw: new TextEncoder().encode(row.sourceRaw),
        contentType: row.sourceRawContentType ?? null,
        caseNumber: row.caseNumber,
        sourceDocumentId: row.sourceDocumentId ?? null,
        language: row.language,
        court: row.court,
        ecli: row.ecli ?? null,
        decisionDate: row.decisionDate ?? null,
        decisionType: row.decisionType ?? null,
        sourceUrl: row.sourceUrl ?? null,
        documentUrl: row.documentUrl ?? null,
        metadata: row.metadata,
      }) satisfies StoredRawReparseInput,
  );
};

const nssRows = await Promise.all(
  [
    ["cz-nss-22-as-35-2026.html.gz", "22 As 35/2026"],
    ["cz-nss-10-as-124-2025.html.gz", "10 As 124/2025"],
    ["cz-nss-10-azs-28-2026.html.gz", "10 Azs 28/2026"],
  ].map(async ([filename, caseNumber]) => {
    if (filename === undefined || caseNumber === undefined) {
      return panic("Incomplete parser benchmark fixture");
    }
    return {
      raw: Bun.gunzipSync(
        await Bun.file(new URL(filename, parserRoot)).bytes(),
      ),
      contentType: "text/html",
      caseNumber,
      sourceDocumentId: null,
      language: "cs",
      court: "Nejvyšší správní soud",
      ecli: null,
      decisionDate: null,
      decisionType: "rozsudek",
      sourceUrl: null,
      documentUrl: null,
      metadata: {},
    } satisfies StoredRawReparseInput;
  }),
);

const sources = [
  {
    adapter: skCourtsAdapter,
    rows: await capturedRows("sk-courts-page.json.gz"),
  },
  { adapter: plSnAdapter, rows: await capturedRows("pl-sn-page.json.gz") },
  { adapter: czNssAdapter, rows: nssRows },
];

const percentile = (values: readonly number[], fraction: number) => {
  const ordered = values.toSorted((left, right) => left - right);
  return (
    ordered.at(Math.ceil(ordered.length * fraction) - 1) ??
    panic("No parser benchmark samples")
  );
};

// A stored replay must never reach a publisher, including during warm-up.
const refuseNetwork = () =>
  panic("Parser benchmark attempted a network request");
globalThis.fetch = Object.assign(refuseNetwork, { preconnect: refuseNetwork });

for (const { adapter, rows } of sources) {
  const reparse = adapter.reparseStoredRaw;
  if (reparse === undefined || rows.length === 0) {
    panic("Parser benchmark source has no replay input");
  }
  const cpuMs: number[] = [];
  const wallMs: number[] = [];
  let rowsWithText = 0;
  for (
    let iteration = -WARMUP_COUNT;
    iteration < SAMPLE_COUNT;
    iteration += 1
  ) {
    const row =
      rows.at(Math.max(0, iteration) % rows.length) ??
      panic("Parser benchmark row is missing");
    const started = performance.now();
    const cpuStarted = process.cpuUsage();
    const result = await reparse(row);
    const cpu = process.cpuUsage(cpuStarted);
    const wall = performance.now() - started;
    if (result.type !== "parsed") {
      panic(
        `Parser benchmark ${adapter.key} rejected a fixture: ${result.type}`,
      );
    }
    if (iteration < 0) {
      continue;
    }
    cpuMs.push((cpu.user + cpu.system) / 1000);
    wallMs.push(wall);
    rowsWithText += Number(Boolean(result.result.fulltext?.trim()));
  }
  const cpuMean = cpuMs.reduce((sum, value) => sum + value, 0) / cpuMs.length;
  console.log(
    JSON.stringify({
      event: "stored_replay_parser_lower_bound",
      source: adapter.key,
      samples: cpuMs.length,
      distinctFixtureRows: rows.length,
      samplesWithDocumentText: rowsWithText,
      warmup: WARMUP_COUNT,
      cpuMs: {
        p50: percentile(cpuMs, 0.5),
        p95: percentile(cpuMs, 0.95),
        mean: cpuMean,
      },
      wallMs: { p50: percentile(wallMs, 0.5), p95: percentile(wallMs, 0.95) },
      coresAtRequiredRate: (cpuMean * 2.03) / 1000,
    }),
  );
}
