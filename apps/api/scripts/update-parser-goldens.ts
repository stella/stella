import { PARSER_PARITY_MANIFEST } from "@/api/handlers/case-law/ingestion/parsers/parity-manifest";
import {
  parityGoldenUrl,
  parserParityOutput,
} from "@/api/tests/helpers/case-law-parity";

for (const entry of PARSER_PARITY_MANIFEST) {
  const output = await parserParityOutput(entry);
  await Bun.write(
    parityGoldenUrl(entry),
    `${JSON.stringify(output, null, 2)}\n`,
  );
  process.stdout.write(`updated ${entry.fixture}\n`);
}
