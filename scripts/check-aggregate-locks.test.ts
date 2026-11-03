import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  aggregateLockBaseline,
  aggregateLockBaselineProblems,
  aggregateLockSites,
} from "../.oxlint-plugins/aggregate-lock-sites.ts";
import {
  AGGREGATE_LOCK_NAMESPACES_PATH,
  aggregateLockNamespaceProblems,
  aggregateLockNamespacesFromSource,
  aggregateLockSourceIncluded,
  parseAggregateLockBaseline,
  parseAggregateLockGitBatch,
  parseAggregateLockNamespaces,
} from "./check-aggregate-locks.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "..");

test("the namespace ledger matches what the owner source declares", () => {
  expect(
    aggregateLockNamespacesFromSource(
      readFileSync(
        path.join(REPO_ROOT, "apps/api/src/lib/db/aggregate-lock.ts"),
        "utf-8",
      ),
    ),
  ).toEqual(
    parseAggregateLockNamespaces(
      readFileSync(
        path.join(REPO_ROOT, AGGREGATE_LOCK_NAMESPACES_PATH),
        "utf-8",
      ),
    ),
  );
});

test("reads literal, named and identity first keys from an owner source", () => {
  const source = [
    "const NAMED_LOCK_NAMESPACE = 0x0f_10_cc_b4;",
    "",
    "const advisoryResource = (options: AdvisoryIdentityOptions) => {",
    "  switch (options.aggregate) {",
    '    case "literal":',
    "      return { first: sql`@{0x0f_10_cc_a9}::integer`, second: sql`0` };",
    '    case "named": {',
    "      const key = options.id;",
    "      return { first: sql`@{NAMED_LOCK_NAMESPACE}::integer`, second: sql`0` };",
    "    }",
    '    case "text":',
    "      return { first: sql`hashtext('text')`, second: sql`0` };",
    '    case "identity":',
    "      return { first: sql`hashtext(@{options.id})`, second: sql`0` };",
    "  }",
    "};",
    "",
  ]
    .join("\n")
    // The fixture spells interpolations with @ so the lines stay plain strings.
    .replaceAll("@{", () => String.fromCodePoint(36, 123));
  expect(aggregateLockNamespacesFromSource(source)).toEqual({
    identity: "hashtext(<identity>)",
    literal: "0x0f10cca9::integer",
    named: "0x0f10ccb4::integer",
    text: "hashtext('text')",
  });
});

test("an aggregate keeps its deployed namespace and a new one takes a fresh one", () => {
  const previous = {
    kept: "0x0f10cca9::integer",
    moved: "0x0f10ccae::integer",
    removed: "0x0f10ccaf::integer",
  };
  expect(
    aggregateLockNamespaceProblems({
      current: {
        kept: "0x0f10cca9::integer",
        moved: "0x0f10ccb3::integer",
        reusing: "0x0f10ccaf::integer",
        fresh: "0x0f10ccb4::integer",
        duplicate: "0x0f10ccb4::integer",
      },
      previous,
    }),
  ).toEqual([
    "duplicate: advisory first-key namespace 0x0f10ccb4::integer is also fresh's; give each aggregate its own.",
    "moved: advisory first-key namespace changed from 0x0f10ccae::integer to 0x0f10ccb3::integer; workers of the base revision still lock 0x0f10ccae::integer, so keep it.",
    "reusing: advisory first-key namespace 0x0f10ccaf::integer belongs to removed on the base revision; choose one no revision has used.",
  ]);
  expect(
    aggregateLockNamespaceProblems({
      current: { kept: "0x0f10cca9::integer", fresh: "0x0f10ccb4::integer" },
      previous,
    }),
  ).toEqual([]);
});

test("enumerates production source while retaining owner and migration boundaries", () => {
  expect(aggregateLockSourceIncluded("apps/api/src/handlers/new.ts")).toBe(
    true,
  );
  expect(aggregateLockSourceIncluded("packages/new/src/worker.ts")).toBe(true);
  expect(
    aggregateLockSourceIncluded("apps/api/src/lib/db/aggregate-lock.ts"),
  ).toBe(false);
  expect(
    aggregateLockSourceIncluded("apps/api/drizzle/new/migration.sql"),
  ).toBe(false);
  expect(aggregateLockSourceIncluded("apps/api/src/lib/example.test.ts")).toBe(
    false,
  );
});
test("requires a reason for each baseline occurrence", () => {
  expect(() =>
    parseAggregateLockBaseline('[{"file":"x","fingerprint":"y","count":1}]'),
  ).toThrow("Invalid key");
});

test("reads batch source bodies by bytes and preserves missing paths", () => {
  const source = "const text = 'příloha';\n";
  const bytes = Buffer.from(source);
  const batch = Buffer.concat([
    Buffer.from(`abcd blob ${bytes.length}\n`),
    bytes,
    Buffer.from("\nbase:new.ts missing\n"),
  ]);
  expect(parseAggregateLockGitBatch(batch, ["existing.ts", "new.ts"])).toEqual([
    { file: "existing.ts", source },
  ]);
  expect(() =>
    parseAggregateLockGitBatch(Buffer.from("abcd blob 100\nx\n"), ["x.ts"]),
  ).toThrow("Incomplete aggregate lock source body");
});

test("a first baseline cannot enroll a newly added source file", () => {
  const rows = aggregateLockBaseline(
    aggregateLockSites("new.ts", 'query.for("update")'),
  );
  const baseSources = parseAggregateLockGitBatch(
    Buffer.from("base:new.ts missing\n"),
    ["new.ts"],
  );
  const previous = aggregateLockBaseline(
    baseSources.flatMap(({ file, source }) => aggregateLockSites(file, source)),
  );
  expect(rows).toHaveLength(1);
  expect(
    aggregateLockBaselineProblems({ actual: rows, baseline: rows, previous }),
  ).toContainEqual(expect.stringContaining("may only shrink"));
});

for (const primitive of [
  "pg_advisory_xact_lock_shared",
  "pg_try_advisory_xact_lock_shared",
]) {
  test(`enumerates and rejects unowned ${primitive} acquisitions`, () => {
    const sites = aggregateLockSites(
      "packages/new/src/worker.ts",
      `tx.execute("SELECT ${primitive}(1, 2)");`,
    );
    expect(sites).toHaveLength(1);
    expect(sites.at(0)?.primitive).toBe(`${primitive}(`);
    expect(
      aggregateLockBaselineProblems({
        actual: aggregateLockBaseline(sites),
        baseline: [],
      }),
    ).not.toHaveLength(0);
  });
}
