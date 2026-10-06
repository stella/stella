import { PGlite } from "@electric-sql/pglite";
import { panic } from "better-result";
import { expect, test } from "bun:test";
import { eq, is, sql } from "drizzle-orm";
import { getTableConfig, IndexedColumn, PgDialect } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { usagePolicies } from "@/api/db/schema";

import { parseSeeds, runSeedReport } from "./seed-usage-policies-runner";

const policy = (key: string) => ({
  key,
  displayName: "Private display",
  description: "Private description",
  hostedPolicyRef: `private-ref-${key}`,
  monthlyUsageUnits: 10,
  visibility: "public",
});

const withDatabase = async (
  check: (db: ReturnType<typeof drizzle>, dir: string) => Promise<void>,
) => {
  const client = new PGlite();
  const dir = mkdtempSync(nodePath.join(tmpdir(), "policy-report-"));
  // Derive fixture columns and defaults from the owning schema.
  const columns = getTableConfig(usagePolicies).columns.map(
    (column) =>
      sql`${sql.identifier(column.name)} ${sql.raw(column.getSQLType())} ${column.notNull ? sql`NOT NULL` : sql``} ${column.default === undefined ? sql`` : sql`DEFAULT ${column.default}`}`,
  );
  // Unique indexes come from the schema too, so the fixture enforces the same
  // one-active-free-policy rule the database does.
  const uniqueIndexes = getTableConfig(usagePolicies)
    .indexes.filter(({ config }) => config.unique)
    .map(({ config: { name, columns: indexColumns, where } }) => {
      const names = indexColumns.map((column) =>
        is(column, IndexedColumn) && column.name !== undefined
          ? sql.identifier(column.name)
          : panic("usage policy fixture supports column indexes only"),
      );
      return sql`CREATE UNIQUE INDEX ${sql.identifier(name ?? panic("unnamed usage policy index"))} ON usage_policies (${sql.join(names, sql`, `)}) ${where === undefined ? sql`` : sql`WHERE ${where}`}`;
    });
  const dialect = new PgDialect();
  const statements = [
    sql`CREATE TABLE usage_policies (${sql.join(columns, sql`, `)})`,
    ...uniqueIndexes,
  ].map((statement) => dialect.sqlToQuery(statement.inlineParams()).sql);
  try {
    await client.exec(statements.join(";\n"));
    await check(drizzle({ client }), dir);
  } finally {
    await client.close();
    rmSync(dir, { recursive: true });
  }
};

const readRows = (path: string) =>
  readFileSync(path, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

test("reports inserted, updated, unchanged and omitted public rows, then reaches a fixed point", async () => {
  await withDatabase(async (db, dir) => {
    const seeds = [policy("retained"), policy("retired")];
    const first = await runSeedReport({
      freeTier: "off",
      mode: "apply",
      input: JSON.stringify(seeds),
      resultsPath: nodePath.join(dir, "first.jsonl"),
      openDb: () => db,
    });
    expect(first.status).toBe("complete");
    expect(readRows(nodePath.join(dir, "first.jsonl"))).toEqual(
      seeds.map(({ key }) => ({
        policyKey: key,
        mode: "apply",
        outcome: "inserted",
      })),
    );
    const replay = await runSeedReport({
      freeTier: "off",
      mode: "apply",
      input: JSON.stringify(seeds),
      resultsPath: nodePath.join(dir, "replay.jsonl"),
      openDb: () => db,
    });
    expect(replay.rows.map((row) => row.outcome)).toEqual([
      "unchanged",
      "unchanged",
    ]);
    // Every mutable seeded field must independently participate in change detection.
    const changes = parseSeeds(
      JSON.stringify([
        {
          ...policy("retained"),
          displayName: "Changed",
          description: "Changed",
          kind: "addon",
          monthlyUsageUnits: 11,
          hostedPolicyRef: "changed-ref",
          priceAmountCents: 100,
          priceCurrency: "EUR",
          billingInterval: "month",
          priceBasis: "per_seat",
          storageBytesPerAssignment: 100,
          serviceActionsPerPeriod: 3,
          maxMembers: 2,
          visibility: "hidden",
          sortOrder: 1,
        },
      ]),
      "off",
    ).at(0);
    expect(changes).toBeDefined();
    for (const [field, value] of Object.entries(changes ?? {})) {
      if (
        field === "key" ||
        field === "priceCurrency" ||
        field === "billingInterval"
      ) {
        continue;
      }
      const changed = {
        ...policy("retained"),
        [field]: value,
        ...(field === "priceAmountCents"
          ? { priceCurrency: "EUR", billingInterval: "month" }
          : {}),
      };
      const path = nodePath.join(dir, `${field}.jsonl`);
      const report = await runSeedReport({
        freeTier: "off",
        mode: "apply",
        input: JSON.stringify([changed]),
        resultsPath: path,
        openDb: () => db,
      });
      expect(report.status).toBe("complete");
      expect(readRows(path)).toContainEqual({
        policyKey: "retained",
        mode: "apply",
        outcome: "updated",
      });
      await runSeedReport({
        freeTier: "off",
        mode: "apply",
        input: JSON.stringify([policy("retained")]),
        resultsPath: nodePath.join(dir, `${field}-reset.jsonl`),
        openDb: () => db,
      });
    }
    const priced = {
      ...policy("retained"),
      priceAmountCents: 100,
      priceCurrency: "EUR",
      billingInterval: "month",
    };
    await runSeedReport({
      freeTier: "off",
      mode: "apply",
      input: JSON.stringify([priced]),
      resultsPath: nodePath.join(dir, "priced.jsonl"),
      openDb: () => db,
    });
    for (const [field, value] of Object.entries({
      priceCurrency: "USD",
      billingInterval: "year",
    })) {
      const path = nodePath.join(dir, `${field}.jsonl`);
      const report = await runSeedReport({
        freeTier: "off",
        mode: "apply",
        input: JSON.stringify([{ ...priced, [field]: value }]),
        resultsPath: path,
        openDb: () => db,
      });
      expect(report.rows).toEqual([
        { policyKey: "retained", mode: "apply", outcome: "updated" },
      ]);
      await runSeedReport({
        freeTier: "off",
        mode: "apply",
        input: JSON.stringify([priced]),
        resultsPath: nodePath.join(dir, `${field}-reset.jsonl`),
        openDb: () => db,
      });
    }
    await runSeedReport({
      freeTier: "off",
      mode: "apply",
      input: JSON.stringify([policy("retained")]),
      resultsPath: nodePath.join(dir, "unpriced.jsonl"),
      openDb: () => db,
    });
    const hiddenRows = readRows(nodePath.join(dir, "displayName.jsonl"));
    expect(hiddenRows).toContainEqual({
      policyKey: "retired",
      mode: "apply",
      outcome: "hidden",
    });
    const rows = await db
      .select({
        key: usagePolicies.policyKey,
        visibility: usagePolicies.visibility,
      })
      .from(usagePolicies);
    expect(rows).toContainEqual({ key: "retired", visibility: "hidden" });
    const final = await runSeedReport({
      freeTier: "off",
      mode: "apply",
      input: JSON.stringify([policy("retained")]),
      resultsPath: nodePath.join(dir, "final.jsonl"),
      openDb: () => db,
    });
    expect(final.rows).toEqual([
      { policyKey: "retained", mode: "apply", outcome: "unchanged" },
    ]);
    for (const row of hiddenRows) {
      expect(Object.keys(row).toSorted()).toEqual([
        "mode",
        "outcome",
        "policyKey",
      ]);
    }
  });
});

test("writes attempted rows and the failing row after rollback, without private values", async () => {
  await withDatabase(async (db, dir) => {
    const path = nodePath.join(dir, "failed.jsonl");
    const report = await runSeedReport({
      freeTier: "off",
      mode: "apply",
      input: JSON.stringify([
        policy("first"),
        { ...policy("second"), hostedPolicyRef: "private-ref-first" },
      ]),
      resultsPath: path,
      openDb: () => db,
    });
    expect(report.status).toBe("failed");
    const rows = readRows(path);
    expect(rows.map((row) => [row.policyKey, row.outcome])).toEqual([
      ["first", "failed"],
      ["second", "failed"],
    ]);
    for (const row of rows) {
      expect(Object.keys(row).toSorted()).toEqual([
        "mode",
        "outcome",
        "policyKey",
        "reason",
      ]);
      expect(row.reason).toContain("rolled back");
    }
    expect(readFileSync(path, "utf-8")).not.toContain("private-ref");
    expect(readFileSync(path, "utf-8")).not.toContain("Private");
    expect(await db.select().from(usagePolicies)).toEqual([]);
  });
});

test("an invalid configuration produces an empty file without opening the database", async () => {
  const dir = mkdtempSync(nodePath.join(tmpdir(), "policy-empty-"));
  try {
    const path = nodePath.join(dir, "invalid.jsonl");
    const report = await runSeedReport({
      freeTier: "off",
      mode: "apply",
      input: "invalid JSON",
      resultsPath: path,
      openDb: () => {
        throw new TypeError("Unexpected database access");
      },
    });
    expect(report.status).toBe("failed");
    expect(readFileSync(path, "utf-8")).toBe("");
    let opened = false;
    const rejection = await runSeedReport({
      freeTier: "off",
      mode: "apply",
      input: "[]",
      resultsPath: path,
      openDb: () => {
        opened = true;
        throw new TypeError("Unexpected database access");
      },
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(() => {
      throw rejection;
    }).toThrow("EEXIST");
    expect(opened).toBe(false);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("retirement failure rolls back seeded rows and reports failure", async () => {
  await withDatabase(async (db, dir) => {
    await runSeedReport({
      freeTier: "off",
      mode: "apply",
      input: JSON.stringify([policy("retired")]),
      resultsPath: nodePath.join(dir, "before.jsonl"),
      openDb: () => db,
    });
    await db.execute(
      sql`CREATE FUNCTION reject_retirement() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private retirement failure'; END $$`,
    );
    await db.execute(
      sql`CREATE TRIGGER reject_retirement BEFORE UPDATE ON usage_policies FOR EACH ROW EXECUTE FUNCTION reject_retirement()`,
    );
    const path = nodePath.join(dir, "failure.jsonl");
    const report = await runSeedReport({
      freeTier: "off",
      mode: "apply",
      input: JSON.stringify([policy("added")]),
      resultsPath: path,
      openDb: () => db,
    });
    expect(report.status).toBe("failed");
    expect(readRows(path)).toEqual([
      {
        policyKey: "added",
        mode: "apply",
        outcome: "failed",
        reason: "Transaction rolled back.",
      },
      {
        policyKey: "retired",
        mode: "apply",
        outcome: "failed",
        reason: "Retirement failed; transaction rolled back.",
      },
    ]);
    expect(
      await db
        .select({
          key: usagePolicies.policyKey,
          visibility: usagePolicies.visibility,
        })
        .from(usagePolicies),
    ).toEqual([{ key: "retired", visibility: "public" }]);
  });
});

test.each(["apply", "dry_run"] as const)(
  "commit failure replaces inserted and hidden outcomes with rolled-back failures (%s)",
  async (mode) => {
    await withDatabase(async (db, dir) => {
      await runSeedReport({
        freeTier: "off",
        mode: "apply",
        input: JSON.stringify([policy("retired")]),
        resultsPath: nodePath.join(dir, "before.jsonl"),
        openDb: () => db,
      });
      await db.execute(sql`DROP INDEX usage_policies_hosted_policy_ref_uidx`);
      await db.execute(
        sql`ALTER TABLE usage_policies ADD UNIQUE (hosted_policy_ref) DEFERRABLE INITIALLY DEFERRED`,
      );
      const path = nodePath.join(dir, "commit-failure.jsonl");
      const report = await runSeedReport({
        freeTier: "off",
        mode,
        input: JSON.stringify([
          policy("first"),
          { ...policy("second"), hostedPolicyRef: "private-ref-first" },
        ]),
        resultsPath: path,
        openDb: () => db,
      });
      expect(report.status).toBe("failed");
      expect(readRows(path)).toEqual(
        ["first", "second", "retired"].map((policyKey) => ({
          policyKey,
          mode,
          outcome: "failed",
          reason: "Transaction rolled back.",
        })),
      );
      expect(
        await db
          .select({
            key: usagePolicies.policyKey,
            visibility: usagePolicies.visibility,
          })
          .from(usagePolicies),
      ).toEqual([{ key: "retired", visibility: "public" }]);
    });
  },
);

test("dry run writes nothing and reports the outcomes the following real run produces", async () => {
  await withDatabase(async (db, dir) => {
    await runSeedReport({
      freeTier: "off",
      mode: "apply",
      input: JSON.stringify(
        ["retained", "retired", "stable"].map((key) => policy(key)),
      ),
      resultsPath: nodePath.join(dir, "before.jsonl"),
      openDb: () => db,
    });
    const input = JSON.stringify([
      { ...policy("retained"), monthlyUsageUnits: 20 },
      policy("stable"),
      policy("added"),
    ]);
    const snapshot = async () =>
      await db.select().from(usagePolicies).orderBy(usagePolicies.policyKey);
    const before = await snapshot();
    const dryRunPath = nodePath.join(dir, "dry-run.jsonl");
    const dryRun = await runSeedReport({
      freeTier: "off",
      mode: "dry_run",
      input,
      resultsPath: dryRunPath,
      openDb: () => db,
    });
    expect(dryRun.status).toBe("complete");
    expect(await snapshot()).toEqual(before);
    expect(readRows(dryRunPath)).toEqual(
      dryRun.rows.map((row) => ({ ...row, mode: "dry_run" })),
    );
    // Every non-failure outcome is exercised, so equality below is not vacuous.
    expect(new Set(dryRun.rows.map(({ outcome }) => outcome))).toEqual(
      new Set(["inserted", "updated", "unchanged", "hidden"]),
    );

    const apply = await runSeedReport({
      freeTier: "off",
      mode: "apply",
      input,
      resultsPath: nodePath.join(dir, "apply.jsonl"),
      openDb: () => db,
    });
    expect(apply.status).toBe("complete");
    expect(apply.rows).toEqual(
      dryRun.rows.map((row) => ({ ...row, mode: "apply" })),
    );
    expect(await snapshot()).not.toEqual(before);
  });
});

test("dry run reports a failing write with the real run's outcomes and rolls back", async () => {
  await withDatabase(async (db, dir) => {
    const input = JSON.stringify([
      policy("first"),
      { ...policy("second"), hostedPolicyRef: "private-ref-first" },
    ]);
    const reports = [];
    for (const mode of ["dry_run", "apply"] as const) {
      const path = nodePath.join(dir, `${mode}.jsonl`);
      const report = await runSeedReport({
        freeTier: "off",
        mode,
        input,
        resultsPath: path,
        openDb: () => db,
      });
      expect(report.status).toBe("failed");
      expect(readFileSync(path, "utf-8")).not.toContain("private-ref");
      reports.push(report.rows.map(({ mode: _mode, ...row }) => row));
    }
    expect(reports.at(0)).toEqual(reports.at(1));
    expect(await db.select().from(usagePolicies)).toEqual([]);
  });
});

const freePolicy = (key: string) => ({
  key,
  displayName: "Free",
  kind: "free",
  monthlyUsageUnits: 0,
  priceAmountCents: 0,
  priceCurrency: "EUR",
  billingInterval: "month",
  maxMembers: 1,
  storageBytesPerAssignment: 1_073_741_824,
  serviceActionsPerPeriod: 3,
  visibility: "public",
});

const readPolicyRows = async (db: ReturnType<typeof drizzle>) =>
  await db
    .select({
      policyKey: usagePolicies.policyKey,
      kind: usagePolicies.kind,
      active: usagePolicies.active,
    })
    .from(usagePolicies)
    .orderBy(usagePolicies.policyKey);

test("a free policy is seeded only while the deployment serves the free floor", async () => {
  await withDatabase(async (db, dir) => {
    const refused = await runSeedReport({
      mode: "apply",
      freeTier: "off",
      input: JSON.stringify([freePolicy("free")]),
      resultsPath: nodePath.join(dir, "refused.jsonl"),
      openDb: () => db,
    });
    expect(refused.status).toBe("failed");
    expect(await readPolicyRows(db)).toEqual([]);

    const seeded = await runSeedReport({
      mode: "apply",
      freeTier: "on",
      input: JSON.stringify([freePolicy("free"), policy("team")]),
      resultsPath: nodePath.join(dir, "seeded.jsonl"),
      openDb: () => db,
    });
    expect(seeded.status).toBe("complete");
    expect(await readPolicyRows(db)).toEqual([
      { policyKey: "free", kind: "free", active: true },
      { policyKey: "team", kind: "subscription", active: true },
    ]);
  });
});

test("a free policy absent from the seeds stops applying", async () => {
  await withDatabase(async (db, dir) => {
    await runSeedReport({
      mode: "apply",
      freeTier: "on",
      input: JSON.stringify([freePolicy("free"), policy("team")]),
      resultsPath: nodePath.join(dir, "first.jsonl"),
      openDb: () => db,
    });
    const report = await runSeedReport({
      mode: "apply",
      freeTier: "off",
      input: JSON.stringify([policy("team")]),
      resultsPath: nodePath.join(dir, "second.jsonl"),
      openDb: () => db,
    });
    expect(report.status).toBe("complete");
    expect(report.rows).toContainEqual({
      policyKey: "free",
      mode: "apply",
      outcome: "deactivated",
    });
    expect(await readPolicyRows(db)).toEqual([
      { policyKey: "free", kind: "free", active: false },
      { policyKey: "team", kind: "subscription", active: true },
    ]);
  });
});

test("replacing the seeded free key retires the previous free policy first", async () => {
  await withDatabase(async (db, dir) => {
    await runSeedReport({
      mode: "apply",
      freeTier: "on",
      input: JSON.stringify([freePolicy("free-a")]),
      resultsPath: nodePath.join(dir, "first.jsonl"),
      openDb: () => db,
    });
    const report = await runSeedReport({
      mode: "apply",
      freeTier: "on",
      input: JSON.stringify([freePolicy("free-b")]),
      resultsPath: nodePath.join(dir, "second.jsonl"),
      openDb: () => db,
    });
    expect(report.rows).toEqual([
      { policyKey: "free-a", mode: "apply", outcome: "deactivated" },
      { policyKey: "free-b", mode: "apply", outcome: "inserted" },
      { policyKey: "free-a", mode: "apply", outcome: "hidden" },
    ]);
    expect(report.status).toBe("complete");
    expect(await readPolicyRows(db)).toEqual([
      { policyKey: "free-a", kind: "free", active: false },
      { policyKey: "free-b", kind: "free", active: true },
    ]);
  });
});

test("re-seeding a retired free policy makes it apply again", async () => {
  await withDatabase(async (db, dir) => {
    const apply = async (name: string, input: unknown[]) =>
      await runSeedReport({
        mode: "apply",
        freeTier: "on",
        input: JSON.stringify(input),
        resultsPath: nodePath.join(dir, `${name}.jsonl`),
        openDb: () => db,
      });
    await apply("seeded", [freePolicy("free"), policy("team")]);
    await apply("retired", [policy("team")]);
    expect(await readPolicyRows(db)).toContainEqual({
      policyKey: "free",
      kind: "free",
      active: false,
    });
    const restored = await apply("restored", [
      freePolicy("free"),
      policy("team"),
    ]);
    expect(restored.rows).toEqual([
      { policyKey: "free", mode: "apply", outcome: "updated" },
      { policyKey: "team", mode: "apply", outcome: "unchanged" },
    ]);
    expect(await readPolicyRows(db)).toEqual([
      { policyKey: "free", kind: "free", active: true },
      { policyKey: "team", kind: "subscription", active: true },
    ]);
  });
});

test("an empty configuration retires the free policy and keeps the public catalog", async () => {
  await withDatabase(async (db, dir) => {
    await runSeedReport({
      mode: "apply",
      freeTier: "on",
      input: JSON.stringify([freePolicy("free"), policy("team")]),
      resultsPath: nodePath.join(dir, "first.jsonl"),
      openDb: () => db,
    });
    const report = await runSeedReport({
      mode: "apply",
      freeTier: "off",
      input: "[]",
      resultsPath: nodePath.join(dir, "empty.jsonl"),
      openDb: () => db,
    });
    expect(report.rows).toEqual([
      { policyKey: "free", mode: "apply", outcome: "deactivated" },
    ]);
    expect(report.status).toBe("complete");
    expect(await readPolicyRows(db)).toEqual([
      { policyKey: "free", kind: "free", active: false },
      { policyKey: "team", kind: "subscription", active: true },
    ]);
    const [team] = await db
      .select({ visibility: usagePolicies.visibility })
      .from(usagePolicies)
      .where(eq(usagePolicies.policyKey, "team"));
    expect(team?.visibility).toBe("public");
  });
});

test("seeds reject a second free policy and every incomplete or priced free shape", () => {
  expect(() =>
    parseSeeds(JSON.stringify([freePolicy("free")]), "on"),
  ).not.toThrow();
  expect(() =>
    parseSeeds(
      JSON.stringify([freePolicy("free"), freePolicy("free-two")]),
      "on",
    ),
  ).toThrow("at most one free policy may be seeded");
  for (const invalid of [
    { hostedPolicyRef: "free-ref" },
    { priceAmountCents: 100 },
    { maxMembers: null },
    { storageBytesPerAssignment: null },
    { serviceActionsPerPeriod: null },
  ]) {
    expect(() =>
      parseSeeds(JSON.stringify([{ ...freePolicy("free"), ...invalid }]), "on"),
    ).toThrow("a free policy has no hosted reference");
  }
  expect(() => parseSeeds(JSON.stringify([freePolicy("free")]), "off")).toThrow(
    "A free policy requires FEATURE_FREE_TIER",
  );
});
