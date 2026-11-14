import { panic } from "better-result";
import { afterEach, expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { PARSER_PARITY_MANIFEST } from "@/api/handlers/case-law/ingestion/parsers/parity-manifest";
import {
  parityGoldenUrl,
  parserParityOutput,
} from "@/api/tests/helpers/case-law-parity";
import { createTestFetch } from "@/api/tests/helpers/test-fetch";

const testFetchState = createTestFetch();

afterEach(() => {
  testFetchState.restore();
});

for (const entry of PARSER_PARITY_MANIFEST) {
  test(`${entry.adapterKey}: ${entry.fixture} matches its parser golden`, async () => {
    const goldenUrl = parityGoldenUrl(entry);
    const golden = Bun.file(goldenUrl);
    if (!(await golden.exists())) {
      panic(
        `Missing parser golden for ${entry.fixture}. Run bun apps/api/scripts/update-parser-goldens.ts to generate it.`,
      );
    }
    const expected: unknown = await golden.json();
    const actual = await parserParityOutput(entry);
    expect(expected).toEqual(actual);
    if ("identity" in entry) {
      expect(actual.documentAst).toMatchObject({
        metadata: {
          caseNumber: entry.identity.caseNumber,
          ecli: entry.identity.ecli,
          decisionDate: entry.identity.decisionDate,
        },
      });
    }
  });
}

for (const entry of PARSER_PARITY_MANIFEST) {
  test(`${entry.adapterKey}: changing the manifest input cannot reuse an unrelated capture`, async () => {
    expect(
      await rejectionOf(
        parserParityOutput({
          ...entry,
          fixture: "parsers/__fixtures__/missing-parity-capture",
        }),
      ),
    ).toMatchObject({ code: "ENOENT" });
  });
}
