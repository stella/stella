import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
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
  const query = new PgDialect().sqlToQuery(
    sql`CREATE TABLE usage_policies (${sql.join(columns, sql`, `)}, UNIQUE (policy_key), UNIQUE (hosted_policy_ref))`.inlineParams(),
  );
  try {
    await client.exec(query.sql);
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
      input: JSON.stringify(seeds),
      resultsPath: nodePath.join(dir, "first.jsonl"),
      openDb: () => db,
    });
    expect(first.status).toBe("complete");
    expect(readRows(nodePath.join(dir, "first.jsonl"))).toEqual(
      seeds.map(({ key }) => ({ policyKey: key, outcome: "inserted" })),
    );
    const replay = await runSeedReport({
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
          serviceActionsPerPeriod: 10,
          maxMembers: 2,
          visibility: "hidden",
          sortOrder: 1,
        },
      ]),
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
        input: JSON.stringify([changed]),
        resultsPath: path,
        openDb: () => db,
      });
      expect(report.status).toBe("complete");
      expect(readRows(path)).toContainEqual({
        policyKey: "retained",
        outcome: "updated",
      });
      await runSeedReport({
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
        input: JSON.stringify([{ ...priced, [field]: value }]),
        resultsPath: path,
        openDb: () => db,
      });
      expect(report.rows).toEqual([
        { policyKey: "retained", outcome: "updated" },
      ]);
      await runSeedReport({
        input: JSON.stringify([priced]),
        resultsPath: nodePath.join(dir, `${field}-reset.jsonl`),
        openDb: () => db,
      });
    }
    await runSeedReport({
      input: JSON.stringify([policy("retained")]),
      resultsPath: nodePath.join(dir, "unpriced.jsonl"),
      openDb: () => db,
    });
    const hiddenRows = readRows(nodePath.join(dir, "displayName.jsonl"));
    expect(hiddenRows).toContainEqual({
      policyKey: "retired",
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
      input: JSON.stringify([policy("retained")]),
      resultsPath: nodePath.join(dir, "final.jsonl"),
      openDb: () => db,
    });
    expect(final.rows).toEqual([
      { policyKey: "retained", outcome: "unchanged" },
    ]);
    for (const row of hiddenRows) {
      expect(Object.keys(row).toSorted()).toEqual(["outcome", "policyKey"]);
    }
  });
});

test("writes attempted rows and the failing row after rollback, without private values", async () => {
  await withDatabase(async (db, dir) => {
    const path = nodePath.join(dir, "failed.jsonl");
    const report = await runSeedReport({
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

test("empty and invalid configurations produce empty files without opening the database", async () => {
  const dir = mkdtempSync(nodePath.join(tmpdir(), "policy-empty-"));
  try {
    for (const [index, input] of ["[]", "invalid JSON"].entries()) {
      const path = nodePath.join(dir, `${index}.jsonl`);
      const report = await runSeedReport({
        input,
        resultsPath: path,
        openDb: () => {
          throw new TypeError("Unexpected database access");
        },
      });
      expect(report.status).toBe(index === 0 ? "complete" : "failed");
      expect(readFileSync(path, "utf-8")).toBe("");
    }
    let opened = false;
    const rejection = await runSeedReport({
      input: "[]",
      resultsPath: nodePath.join(dir, "0.jsonl"),
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
      input: JSON.stringify([policy("added")]),
      resultsPath: path,
      openDb: () => db,
    });
    expect(report.status).toBe("failed");
    expect(readRows(path)).toEqual([
      {
        policyKey: "added",
        outcome: "failed",
        reason: "Transaction rolled back.",
      },
      {
        policyKey: "retired",
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

test("commit failure replaces inserted and hidden outcomes with rolled-back failures", async () => {
  await withDatabase(async (db, dir) => {
    await runSeedReport({
      input: JSON.stringify([policy("retired")]),
      resultsPath: nodePath.join(dir, "before.jsonl"),
      openDb: () => db,
    });
    await db.execute(
      sql`ALTER TABLE usage_policies DROP CONSTRAINT usage_policies_hosted_policy_ref_key`,
    );
    await db.execute(
      sql`ALTER TABLE usage_policies ADD UNIQUE (hosted_policy_ref) DEFERRABLE INITIALLY DEFERRED`,
    );
    const path = nodePath.join(dir, "commit-failure.jsonl");
    const report = await runSeedReport({
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
});
