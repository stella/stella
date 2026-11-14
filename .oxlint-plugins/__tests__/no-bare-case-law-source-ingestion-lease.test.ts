import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const RULE = "no-bare-case-law-source-ingestion-lease";
const SOURCE_PATH = "apps/api/src/lib/legal-search/example.ts";

const lint = async (source: string, sourcePath = SOURCE_PATH) =>
  await lintSingleRule(RULE, source, { sourcePath });

test("reports imported, local, and namespace aliases", async () => {
  expect(
    await lint(
      [
        'import { acquireCaseLawSourceIngestionLease as claim } from "./case-law-source-ingestion-lease";',
        'import { acquireCaseLawSourceIngestionLease } from "./case-law-source-ingestion-lease";',
        'import * as leases from "./case-law-source-ingestion-lease";',
        "const localClaim = acquireCaseLawSourceIngestionLease;",
        "await claim(options);",
        "await localClaim(options);",
        "await leases.acquireCaseLawSourceIngestionLease(options);",
      ].join("\n"),
    ),
  ).toEqual([1, 2, 5, 6, 7]);
});

test("reports the acquisition taken in as a value, under any name", async () => {
  expect(
    await lint(
      [
        'import { acquireCaseLawSourceIngestionLease } from "./case-law-source-ingestion-lease";',
        "await waitFor({ acquire: acquireCaseLawSourceIngestionLease });",
        'const { acquireCaseLawSourceIngestionLease: claim } = await import("./case-law-source-ingestion-lease");',
        'const leases = await import("./case-law-source-ingestion-lease");',
        'await waitFor({ acquire: leases["acquireCaseLawSourceIngestionLease"] });',
        'export { acquireCaseLawSourceIngestionLease } from "./case-law-source-ingestion-lease";',
        "await withCaseLawSourceIngestionLease(options, work);",
      ].join("\n"),
    ),
  ).toEqual([1, 3, 5, 6]);
});

test("accepts aliases inside the lease owner", async () => {
  expect(
    await lint(
      [
        'import { acquireCaseLawSourceIngestionLease as claim } from "./dependency";',
        "const localClaim = claim;",
        "await localClaim(options);",
      ].join("\n"),
      "apps/api/src/lib/legal-search/case-law-source-ingestion-lease.ts",
    ),
  ).toEqual([]);
});
