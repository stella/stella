import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

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
  ).toEqual([5, 6, 7]);
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

test("enforces only changed calls during rollout", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "case-law-lease-rollout-"),
  );
  const wrapper = path.join(directory, "plugin.ts");
  const plugin = path.resolve(
    import.meta.dirname,
    "../no-bare-case-law-source-ingestion-lease.ts",
  );
  const scope = path.resolve(
    import.meta.dirname,
    "../../scripts/guard-rollouts.ts",
  );
  const portablePath = path.resolve(
    import.meta.dirname,
    "../../packages/portable-path/src/index.ts",
  );
  const repository = path.resolve(import.meta.dirname, "../..");
  await Bun.write(
    wrapper,
    `import { createCaseLawSourceIngestionLeasePlugin } from ${JSON.stringify(plugin)};
import { guardEnforcesLine } from ${JSON.stringify(scope)};
import { repoRelativePath } from ${JSON.stringify(portablePath)};
export default createCaseLawSourceIngestionLeasePlugin((options) => guardEnforcesLine({
  ...options,
  rollouts: [{ id: "no-bare-case-law-source-ingestion-lease", type: "changed-lines", expiresAt: "2026-11-05T00:00:00.000Z", check: ["bun", "check"] }],
  now: new Date("2026-10-30"),
  changedLines: new Map([[repoRelativePath(${JSON.stringify(repository)}, options.file), new Set([2])]]),
}));
`,
  );

  try {
    expect(
      await lintSingleRule(
        RULE,
        [
          "await acquireCaseLawSourceIngestionLease(existingOptions);",
          "await acquireCaseLawSourceIngestionLease(changedOptions);",
        ].join("\n"),
        { sourcePath: SOURCE_PATH, pluginPath: wrapper },
      ),
    ).toEqual([2]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
