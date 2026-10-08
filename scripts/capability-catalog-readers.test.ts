import { expect, test } from "bun:test";

const historicalCatalogConsumers = new Set([
  // These compare a pre-cutover revision or published tarball with the shards.
  "scripts/capability-shard-pack.test.ts",
  "scripts/check-cli-contract-changeset.ts",
  "scripts/check-cli-contract-changeset.test.ts",
  "scripts/check-cli-release-coupling.ts",
  "scripts/check-cli-release-coupling.test.ts",
  "scripts/cli-runtime-pack.test.ts",
  // This archived plan describes the original catalog layout.
  ".agents/plans/049-capability-catalog-full-surface-cli.md",
]);
const runtimeAggregateOwners = new Set([
  // The bundled API imports generated aggregates produced from the shards.
  "apps/api/src/mcp/capability-tools.ts",
  // Checks the cursor bounds of the bundled runtime output contracts.
  "apps/api/src/mcp/cursor-envelope-bounds.test.ts",
  // Generation, formatting, graph analysis and cache declarations own outputs.
  "scripts/generated-files.ts",
  "packages/scripts/src/generated-files.ts",
  // Exercises runtime generation in a packaged checkout.
  "packages/scripts/src/prepared-generated-sources.test.ts",
  ".oxfmtrc.json",
  "knip.json",
  "turbo.json",
]);

test("catalog consumers cannot reintroduce the removed monolithic paths", () => {
  const catalog = ["capability", "catalog.json"].join("-");
  const aggregate = ["generated", "capability-catalog"].join("/");
  for (const [pattern, owners] of [
    [catalog, historicalCatalogConsumers],
    [aggregate, runtimeAggregateOwners],
  ] as const) {
    const matches = Bun.spawnSync(
      [
        "git",
        "grep",
        "-l",
        "-z",
        "-I",
        "-F",
        pattern,
        "--",
        "*.ts",
        "*.tsx",
        "*.mts",
        "*.cts",
        "*.js",
        "*.jsx",
        "*.mjs",
        "*.cjs",
        "*.json",
        "*.yml",
        "*.yaml",
        "*.sh",
        "*.md",
        ":(exclude)provenance/**",
      ],
      {
        cwd: new URL("../", import.meta.url).pathname,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect([0, 1], matches.stderr.toString()).toContain(matches.exitCode);
    const readers = matches.stdout.toString().split("\0").filter(Boolean);
    expect(
      readers.filter((file) => !owners.has(file)),
      pattern,
    ).toEqual([]);
  }
});
