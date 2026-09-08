/**
 * Re-stamp the seeded analyses in the case-law fixtures with the input they
 * describe today.
 *
 * A stored analysis carries a digest of the exact model input it was computed
 * over: the decision's anchored text and the system prompt. The reader serves
 * it only while that digest still matches, so editing an analysis prompt
 * makes every stored analysis stale by construction, the seeded ones
 * included. In production that is the point, and the next open regenerates.
 * The seeded fixtures have no model to regenerate with, so a prompt change
 * would otherwise leave the local reader and the marketing capture with no
 * analysis at all.
 *
 * This recomputes each fixture analysis's `inputFingerprint` from the
 * fixture's own document and the current prompt, and rewrites the archives.
 * The trees themselves are untouched: their anchors name blocks of the same
 * document, which has not changed.
 *
 *   bun run apps/api/scripts/refresh-case-law-fixture-analyses.ts
 *   bun run apps/api/scripts/refresh-case-law-fixture-analyses.ts --check
 *
 * `--check` reports drift and writes nothing;
 * `case-law-fixture-analysis.test.ts` runs the same comparison, so a prompt
 * change fails a unit test rather than a screenshot capture.
 */

import { gzipSync } from "node:zlib";

import {
  CASE_LAW_FIXTURES_DIR,
  readCaseLawFixtureAnalyses,
  type CaseLawFixtureAnalysis,
} from "./lib/case-law-fixture-analyses";

const check = process.argv.includes("--check");

const stale: CaseLawFixtureAnalysis[] = [];
let rewritten = 0;

for (const {
  entries,
  fixture,
  path: fixturePath,
} of await readCaseLawFixtureAnalyses()) {
  const drifted = entries.filter((entry) => !entry.matches);
  if (drifted.length === 0) {
    continue;
  }
  stale.push(...drifted);
  if (check) {
    continue;
  }
  for (const entry of drifted) {
    entry.analysis.inputFingerprint = entry.currentFingerprint;
  }
  await Bun.write(fixturePath, gzipSync(JSON.stringify(fixture)));
  rewritten += 1;
}

for (const entry of stale) {
  console.log(
    `${entry.fixtureName} ${entry.caseNumber}: ${entry.storedFingerprint.slice(0, 12)} -> ${entry.currentFingerprint.slice(0, 12)}`,
  );
}

if (stale.length === 0) {
  console.log(
    `case-law fixture analyses: every stored analysis names the current input (${CASE_LAW_FIXTURES_DIR}).`,
  );
  process.exit(0);
}

if (check) {
  console.error(
    `case-law fixture analyses: ${String(stale.length)} stale. Run ` +
      "`bun run apps/api/scripts/refresh-case-law-fixture-analyses.ts` and commit the fixtures.",
  );
  process.exit(1);
}

console.log(
  `case-law fixture analyses: re-stamped ${String(stale.length)} analyses across ${String(rewritten)} fixtures.`,
);
