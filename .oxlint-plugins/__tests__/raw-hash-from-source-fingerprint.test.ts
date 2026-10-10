import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

setDefaultTimeout(20_000);

const ADAPTER = "apps/api/src/handlers/case-law/ingestion/adapters/example.ts";

const lint = async (source: string, ruleOptions?: unknown) =>
  await lintSingleRule("raw-hash-from-source-fingerprint", source, {
    sourcePath: ADAPTER,
    ruleOptions,
  });

describe("raw-hash-from-source-fingerprint", () => {
  test("rejects a rawHash written without the owner", async () => {
    expect(
      await lint(
        [
          'const a = { rawHash: hashContent(docket + "|" + date) };',
          "const b = build({ caseNumber, rawHash: hashContent(sourceRaw) });",
          "const rawHash = hashContent(raw); const c = { rawHash };",
          "decision.rawHash = czSourceHash(parts);",
          'const d = { "rawHash": sha256(html) as string };',
        ].join("\n"),
      ),
    ).toEqual([1, 2, 3, 4, 5]);
  });

  test("accepts the owner and a hash passed through from another decision", async () => {
    expect(
      await lint(
        [
          "const a = { rawHash: sourceFingerprint({ sourceRaw }) };",
          "const b = { rawHash: sourceFingerprint({ sourceRaw, sourceRawObjects }) as string };",
          "const c = { ...decision, rawHash: plan.rawHash };",
          "decision.rawHash = sourceFingerprint({ sourceRaw: raw });",
          "const d = { contentHash: hashContent(raw), [key]: hashContent(raw) };",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test("exempts listed files unless run as a census", async () => {
    const source = "const a = { rawHash: hashContent(raw) };";
    expect(await lint(source, { allowedFiles: [ADAPTER] })).toEqual([]);
    expect(
      await lint(source, { allowedFiles: [ADAPTER], census: true }),
    ).toEqual([1]);
  });
});
