import { afterEach, expect, test } from "bun:test";

import { PARSER_PARITY_MANIFEST } from "@/api/handlers/case-law/ingestion/parsers/parity-manifest";
import {
  parityGoldenUrl,
  parserParityOutput,
} from "@/api/tests/helpers/case-law-parity";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

for (const entry of PARSER_PARITY_MANIFEST) {
  test(`${entry.adapterKey}: ${entry.fixture} matches its parser golden`, async () => {
    const expected: unknown = await Bun.file(parityGoldenUrl(entry)).json();
    const actual: unknown = await parserParityOutput(entry);
    expect(actual).toEqual(expected);
  });
}
