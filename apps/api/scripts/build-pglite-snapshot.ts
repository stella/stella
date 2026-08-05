#!/usr/bin/env bun

// Build the test-database snapshot the batching runner hands to test
// processes (scripts/run-tests.ts): one full schema build in this dedicated
// process, dumped as a PGlite data dir. Test processes then boot via
// loadDataDir and skip the ~2.2 GB drizzle-kit push peak entirely.

import { buildFullTestPglite } from "../src/tests/pglite-test-db";

const outputPath = Bun.argv.at(2);
if (outputPath === undefined || outputPath.length === 0) {
  console.error("usage: build-pglite-snapshot.ts <output-path>");
  process.exit(1);
}

const client = await buildFullTestPglite();
// Uncompressed: the snapshot is written and read once per run on the same
// machine, so gzip would only add CPU time on both ends.
const snapshot = await client.dumpDataDir("none");
await Bun.write(outputPath, snapshot);
await client.close();
