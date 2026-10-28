import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const lint = async (source: string) =>
  await lintSingleRule("no-source-raw-projection", source, {
    sourcePath: "adapter.ts",
  });

describe.serial("publisher raw archive projections", () => {
  test("filtering, picking, omitted rest fields, deleted fields and JSON replacers fail at the write boundary", async () => {
    const projections = [
      "const raw = Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'newField'));",
      "const raw = pick(record, ['known']);",
      "const raw = JSON.stringify({ known: record.known });",
      "const raw = omit(record, ['newField']);",
      "const { newField, ...raw } = record;",
      "const raw = { ...record }; delete raw.newField;",
      "const raw = JSON.stringify(record, ['known']);",
      "const raw = JSON.stringify(record, (key, value) => key === 'newField' ? undefined : value);",
      "const first = omit(record, ['newField']); const raw = first;",
      "const select = (value) => pick(value, ['known']); const raw = select(record);",
      "import { pick as select } from 'lodash-es'; const raw = select(record, ['known']);",
    ];
    const results = await Promise.all(
      projections.map(
        async (projection) =>
          await lint(
            `${projection}\nconst row = { sourceRaw: JSON.stringify(raw) };`,
          ),
      ),
    );
    expect(results).toEqual(projections.map(() => [2]));
  });

  test("a newly introduced raw filter fails even when the envelope constructor is aliased", async () => {
    const prelude =
      "import { encodeSourceRawEnvelope as envelope } from '@/api/lib/legal-search/source-raw-envelope';\n";
    expect(
      await lint(
        `${prelude}const raw = envelope({ listing: JSON.stringify(record) });`,
      ),
    ).toEqual([]);
    expect(
      await lint(
        `${prelude}const raw = envelope({ listing: JSON.stringify(omit(record, ['addedByPublisher'])) });`,
      ),
    ).toEqual([2]);
    expect(
      await lint(
        "decision.sourceRaw = JSON.stringify(pick(record, ['known']));",
      ),
    ).toEqual([1]);
  });

  test("whole publisher payloads and filters on derived projections remain valid", async () => {
    expect(
      await lint(
        [
          "const sourceRaw = encodeSourceRawEnvelope({ listing: JSON.stringify(record), detail: html });",
          "const row = { sourceRaw };",
          "const complete = { sourceRaw: JSON.stringify({ record, selected: { known: record.known } }) };",
          "const parts = encodeSourceRawEnvelope(Object.fromEntries([['contract', JSON.stringify({ version: record.version })], ...Object.keys(record).map((key) => [key, JSON.stringify(record[key])])]));",
          "const selectedReferences = references.filter((reference) => reference.kind === 'case');",
          "const metadata = pick(record, ['court']);",
          "const bytes = JSON.stringify(record, null, 2);",
          "decision.sourceRaw = bytes;",
          "const capture = (value) => { const metadata = omit(value, ['unused']); return JSON.stringify(value); };",
          "const whole = { sourceRaw: capture(record) };",
        ].join("\n"),
      ),
    ).toEqual([]);
  });
});
