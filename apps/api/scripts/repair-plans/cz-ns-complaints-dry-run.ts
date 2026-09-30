#!/usr/bin/env bun

import * as cheerio from "cheerio";
import { createInterface } from "node:readline";
import * as v from "valibot";

import { extractNsMetadata } from "../../src/handlers/case-law/ingestion/parsers/cz-ns";

// Offline export only: no database, storage client, fetch, or apply mode.
const rowSchema = v.strictObject({
  id: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
  adapterKey: v.literal("cz-ns"),
  sourceHash: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
  printHtml: v.pipe(v.string(), v.minLength(1), v.maxLength(10_000_000)),
  metadata: v.record(v.string(), v.unknown()),
});
const MAX_ROWS = 1000;
let count = 0;
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  if (!line.trim()) {
    continue;
  }
  count += 1;
  if (count > MAX_ROWS) {
    process.stderr.write(
      `Input exceeds ${MAX_ROWS} rows; use bounded export batches.\n`,
    );
    process.exitCode = 1;
    break;
  }
  const row = v.parse(rowSchema, JSON.parse(line));
  const { source } = extractNsMetadata(cheerio.load(row.printHtml));
  if (source.ustavniStiznost === undefined) {
    process.stdout.write(
      `${JSON.stringify({
        status: "unresolved",
        id: row.id,
        sourceHash: row.sourceHash,
        reason:
          "Archived print page has no complaint table; retain stored value.",
      })}\n`,
    );
    continue;
  }
  process.stdout.write(
    `${JSON.stringify({
      status: "proposal",
      id: row.id,
      sourceHash: row.sourceHash,
      before: row.metadata["ustavniStiznost"],
      after: source.ustavniStiznost,
    })}\n`,
  );
}
