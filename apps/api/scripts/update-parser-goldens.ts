import { compareCodeUnit } from "@stll/collation";

import { listAdapters } from "@/api/handlers/case-law/ingestion/adapters/adapter-registry";
import { PARSER_PARITY_MANIFEST } from "@/api/handlers/case-law/ingestion/parsers/parity-manifest";
import { PARSER_VERSIONS } from "@/api/lib/legal-search/ingestion-constants";
import { CASE_LAW_CONFORMANCE_FIXTURES } from "@/api/tests/helpers/case-law-enrolled-fixtures";
import {
  parityGoldenUrl,
  parserParityOutput,
  replayParserFingerprint,
} from "@/api/tests/helpers/case-law-parity";

for (const entry of PARSER_PARITY_MANIFEST) {
  const output = await parserParityOutput(entry);
  await Bun.write(
    parityGoldenUrl(entry),
    `${JSON.stringify(output, null, 2)}\n`,
  );
  process.stdout.write(`updated ${entry.fixture}\n`);
}

// Outside a test runner, fixture publisher requests use Redis coordination.
const fingerprints: Record<string, { version: number; fingerprint: string }> =
  {};
const originalFetch = globalThis.fetch;
try {
  for (const adapter of listAdapters()) {
    const fixture = CASE_LAW_CONFORMANCE_FIXTURES[adapter.key];
    const decision = await fixture().buildDecision();
    fingerprints[adapter.key] = {
      version: PARSER_VERSIONS[adapter.key],
      fingerprint: replayParserFingerprint(decision),
    };
    globalThis.fetch = originalFetch;
  }
} finally {
  globalThis.fetch = originalFetch;
}
const ordered = Object.fromEntries(
  Object.entries(fingerprints).toSorted(([left], [right]) =>
    compareCodeUnit(left, right),
  ),
);
await Bun.write(
  new URL(
    "../src/handlers/case-law/ingestion/adapters/replay-parser-fingerprints.json",
    import.meta.url,
  ),
  `${JSON.stringify(ordered, null, 2)}\n`,
);
process.stdout.write("updated replay parser fingerprints\n");
