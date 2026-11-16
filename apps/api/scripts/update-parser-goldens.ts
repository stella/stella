import { listAdapters } from "@/api/handlers/case-law/ingestion/adapters/adapter-registry";
import { writeParserFingerprint } from "@/api/handlers/case-law/ingestion/adapters/replay-parser-fingerprints";
import { PARSER_PARITY_MANIFEST } from "@/api/handlers/case-law/ingestion/parsers/parity-manifest";
import { PARSER_VERSIONS } from "@/api/lib/legal-search/ingestion-constants";
import { CASE_LAW_CONFORMANCE_FIXTURES } from "@/api/tests/helpers/case-law-enrolled-fixtures";
import {
  buildCaseLawFixture,
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
for (const adapter of listAdapters()) {
  const fixture = CASE_LAW_CONFORMANCE_FIXTURES[adapter.key];
  const decision = await buildCaseLawFixture(fixture());
  await writeParserFingerprint({
    key: adapter.key,
    fingerprint: {
      version: PARSER_VERSIONS[adapter.key],
      fingerprint: replayParserFingerprint(decision),
    },
  });
}
process.stdout.write("updated replay parser fingerprints\n");
