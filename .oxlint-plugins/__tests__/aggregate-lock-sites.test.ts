import { describe, expect, test } from "bun:test";

import {
  aggregateLockBaseline,
  aggregateLockBaselineProblems,
  aggregateLockSites,
} from "../aggregate-lock-sites.ts";

const file = "apps/api/src/handlers/example.ts";
describe("aggregate lock confinement", () => {
  test("rejects raw API transaction boundaries including computed spellings", () => {
    for (const method of [
      ".transaction",
      '["transaction"]',
      '["trans" + "action"]',
    ]) {
      const source = `tx${method}(async (nested) => nested.execute(statement));`;
      const sites = aggregateLockSites(file, source);
      expect(sites).toHaveLength(1);
      expect(sites.at(0)?.primitive).toBe("transaction-boundary");
      const actual = aggregateLockBaseline(sites);
      expect(
        aggregateLockBaselineProblems({ actual, baseline: [] }),
      ).toContainEqual(expect.stringContaining("Unowned aggregate lock"));
    }
    expect(
      aggregateLockSites(
        "apps/web/src/example.ts",
        "storage.transaction(work)",
      ),
    ).toEqual([]);
  });
  test("enumerates SQL savepoint creation, release and rollback", () => {
    for (const operation of [
      "SAVEPOINT example",
      "RELEASE SAVEPOINT example",
      "RELEASE example",
      "ROLLBACK TO SAVEPOINT example",
      "ROLLBACK TO example",
    ]) {
      expect(aggregateLockSites(file, `sql\`${operation}\``)).toHaveLength(1);
      expect(
        aggregateLockSites(file, `sql.raw(${JSON.stringify(operation)})`),
      ).toHaveLength(1);
    }
    expect(
      aggregateLockSites(
        file,
        'const message = "Failed to release savepoint example"',
      ),
    ).toEqual([]);
    expect(aggregateLockSites(file, "sql`SELECT 'SAVEPOINT example'`")).toEqual(
      [],
    );
    expect(
      aggregateLockSites(
        file,
        "sql`SAVEPOINT example; RELEASE SAVEPOINT example; ROLLBACK TO example`",
      ),
    ).toHaveLength(3);
  });
  test("requires SQL context for bare RELEASE and ignores release prose", () => {
    for (const message of [
      "Release manifest",
      "Release manifest artifacts",
      "Release reader locks",
      "Release reader",
    ]) {
      expect(
        aggregateLockSites(file, `const message = ${JSON.stringify(message)}`),
      ).toEqual([]);
    }
    for (const source of [
      "sql`RELEASE example`",
      'sql.raw("RELEASE example")',
      'tx.execute("RELEASE example")',
      'connection.query("RELEASE example")',
      'connection.unsafe("RELEASE example")',
      'query("RELEASE example")',
    ]) {
      expect(aggregateLockSites(file, source)).toHaveLength(1);
    }
  });
  test("ignores row-lock words in prose outside SQL context", () => {
    for (const message of [
      "Fetches release metadata for update notifications.",
      "Waits for share links to expire",
      "Polls for key share rotation",
      "Checks the table for update.",
    ]) {
      expect(
        aggregateLockSites(file, `const message = ${JSON.stringify(message)}`),
      ).toEqual([]);
    }
    for (const source of [
      'const query = "SELECT id FROM items WHERE id = $1 FOR UPDATE"',
      "sql`FOR UPDATE`",
      'sql.raw("FOR NO KEY UPDATE")',
      'tx.execute("SELECT id FROM items FOR SHARE")',
      'const clause = lock ? " FOR UPDATE" : ""',
      'const clause = lock ? " for update" : ""',
      'const clause = shared ? "for key share" : ""',
      'const tail = "WHERE id = $1 FOR UPDATE"',
      'const tail = "where id = $1 for update"',
      'const tail = "ORDER BY id FOR NO KEY UPDATE"',
      'const query = "select id from items for update"',
      'const query = "table items for update"',
      'const tail = "fetch first 1 row only for update"',
      'const tail = "limit 1 for update skip locked"',
      'const tail = "for no key update of items nowait"',
      'const query = "TABLE items FOR SHARE"',
      'const tail = "order by id for share"',
    ]) {
      expect(aggregateLockSites(file, source)).toHaveLength(1);
    }
  });
  test("enumerates every mode and computed builder spelling", () => {
    for (const mode of [
      "update",
      "no key update",
      "share",
      "key share",
      "dynamicMode",
    ]) {
      for (const method of [".for", '["for"]', '["f" + "or"]']) {
        expect(
          aggregateLockSites(file, `query${method}(${JSON.stringify(mode)})`),
        ).toHaveLength(1);
      }
    }
    expect(aggregateLockSites(file, 'query["for"](mode)')).toHaveLength(1);
  });
  test("ignores comments and unrelated symbols while detecting SQL literals", () => {
    expect(
      aggregateLockSites(
        file,
        '// query.for("update");\n/* sql`FOR UPDATE` */\nSymbol.for("update")',
      ),
    ).toEqual([]);
    expect(
      aggregateLockSites(
        file,
        'const sql = "SELECT id FROM items FOR\\nNO KEY UPDATE"',
      ),
    ).toHaveLength(1);
    expect(
      aggregateLockSites(
        file,
        `const sql = \`SELECT pg_advisory_xact_lock(\${key})\``,
      ),
    ).toHaveLength(1);
    expect(
      aggregateLockSites(file, "sql`SELECT 'FOR UPDATE' FROM items`"),
    ).toEqual([]);
    expect(
      aggregateLockSites(
        file,
        'const sql = "SELECT id FROM items FOR " + "UPDATE"',
      ),
    ).toHaveLength(1);
    expect(
      aggregateLockSites(
        file,
        `sql\`SELECT pg_advisory_xact_lo\\u0063k(\${key})\``,
      ),
    ).toHaveLength(1);
    expect(
      aggregateLockSites(
        "migration.sql",
        "CREATE POLICY item_update ON items FOR UPDATE TO app USING (true);",
      ),
    ).toEqual([]);
  });
  test("rejects a planted raw acquisition outside the owner", () => {
    const actual = aggregateLockBaseline(
      aggregateLockSites(file, 'tx.select().from(items).for("update");'),
    );
    expect(actual).toHaveLength(1);
    expect(aggregateLockBaselineProblems({ actual, baseline: [] })).toEqual([
      expect.stringContaining("Unowned aggregate lock"),
    ]);
  });
  test("permits deletion only and rejects stale rows, copied calls and changed calls", () => {
    const source = 'tx.select().from(items).for("update");';
    const baseline = aggregateLockBaseline(aggregateLockSites(file, source));
    expect(
      aggregateLockBaselineProblems({
        actual: baseline,
        baseline,
        previous: baseline,
      }),
    ).toEqual([]);
    expect(
      aggregateLockBaselineProblems({
        actual: [],
        baseline: [],
        previous: baseline,
      }),
    ).toEqual([]);
    expect(
      aggregateLockBaselineProblems({ actual: [], baseline }),
    ).toContainEqual(expect.stringContaining("Stale"));
    const copied = aggregateLockBaseline(
      aggregateLockSites(file, source + source),
    );
    expect(
      aggregateLockBaselineProblems({
        actual: copied,
        baseline: copied,
        previous: baseline,
      }),
    ).toContainEqual(expect.stringContaining("may only shrink"));
    const changed = aggregateLockBaseline(
      aggregateLockSites(file, source.replace("update", "share")),
    );
    expect(
      aggregateLockBaselineProblems({
        actual: changed,
        baseline: changed,
        previous: baseline,
      }),
    ).toContainEqual(expect.stringContaining("may only shrink"));
  });
  test("accepts a reviewed rekey of a changed existing acquisition only", () => {
    const source = 'tx.select().from(items).for("update");';
    const baseline = aggregateLockBaseline(aggregateLockSites(file, source));
    const changed = aggregateLockBaseline(
      aggregateLockSites(file, source.replace("update", "no key update")),
    );
    const from = baseline.at(0)?.fingerprint ?? "";
    const to = changed.at(0)?.fingerprint ?? "";
    const rekey = {
      file,
      from,
      to,
      reason: "weaker mode keeps FK inserts unblocked",
    };
    expect(
      aggregateLockBaselineProblems({
        actual: changed,
        baseline: changed,
        previous: baseline,
        rekeys: [rekey],
      }),
    ).toEqual([]);
    // A rekey never admits an extra acquisition: the replaced row must be gone.
    const both = [...baseline, ...changed];
    expect(
      aggregateLockBaselineProblems({
        actual: both,
        baseline: both,
        previous: baseline,
        rekeys: [rekey],
      }),
    ).toContainEqual(expect.stringContaining("may only shrink"));
    // One replaced row funds one replacement, never two.
    const copied = aggregateLockBaseline(
      aggregateLockSites(
        file,
        source.replace("update", "no key update") +
          source.replace("update", "key share"),
      ),
    );
    const second =
      copied.find((row) => row.fingerprint !== to)?.fingerprint ?? "";
    expect(
      aggregateLockBaselineProblems({
        actual: copied,
        baseline: copied,
        previous: baseline,
        rekeys: [rekey, { ...rekey, to: second }],
      }),
    ).toContainEqual(expect.stringContaining("may only shrink"));
    // The count may not grow, a reason is required, and the source must exist.
    const doubled = aggregateLockBaseline(
      aggregateLockSites(
        file,
        source.replace("update", "no key update").repeat(2),
      ),
    );
    for (const rekeys of [
      [rekey],
      [{ ...rekey, reason: " " }],
      [{ ...rekey, from: "missing" }],
    ]) {
      expect(
        aggregateLockBaselineProblems({
          actual: doubled,
          baseline: doubled,
          previous: baseline,
          rekeys,
        }),
      ).toContainEqual(expect.stringContaining("may only shrink"));
    }
    expect(
      aggregateLockBaselineProblems({
        actual: changed,
        baseline: changed,
        previous: baseline,
        rekeys: [{ ...rekey, reason: " " }],
      }),
    ).toContainEqual(expect.stringContaining("may only shrink"));
  });

  test("enumerates transaction and session advisory and table locks", () => {
    for (const name of [
      "pg_advisory_lock",
      "pg_try_advisory_lock_shared",
      "pg_advisory_unlock",
      "pg_advisory_xact_lock",
      "pg_try_advisory_xact_lock_shared",
    ]) {
      expect(aggregateLockSites(file, `sql\`SELECT ${name}(1)\``)).toHaveLength(
        1,
      );
    }
    expect(
      aggregateLockSites(file, "sql`LOCK TABLE items IN EXCLUSIVE MODE`"),
    ).toHaveLength(1);
    expect(
      aggregateLockSites(file, 'sql`SELECT "pg_advisory_xact_lock"(1)`'),
    ).toHaveLength(1);
  });
  test("rejects interpolated lock keywords and raw literal clauses", () => {
    for (const prefix of [
      "FOR",
      "FOR NO",
      "FOR NO KEY",
      "FOR KEY",
      "pg_advisory",
      "pg_advisory_",
      "pg_advisory_xact_",
    ]) {
      const source = `sql\`SELECT id FROM items ${prefix} \${sql.raw(mode)}\``;
      const actual = aggregateLockBaseline(aggregateLockSites(file, source));
      expect(actual).toHaveLength(1);
      expect(
        aggregateLockBaselineProblems({ actual, baseline: [] }),
      ).toContainEqual(expect.stringContaining("Unowned aggregate lock"));
    }
    for (const mode of ["UPDATE", "NO KEY UPDATE", "SHARE", "KEY SHARE"]) {
      const source = `sql\`SELECT id FROM items FOR \${sql.raw(${JSON.stringify(mode)})}\``;
      expect(aggregateLockSites(file, source)).toHaveLength(1);
      expect(
        aggregateLockSites(file, `sql.raw(${JSON.stringify(`FOR ${mode}`)})`),
      ).toHaveLength(1);
    }
    expect(
      aggregateLockSites(file, 'sql.raw("pg_advisory_xact_lock")'),
    ).toHaveLength(1);
    expect(
      aggregateLockSites(file, `sql\`SELECT pg_advisory_xact_lock(\${key})\``),
    ).toHaveLength(1);
    expect(
      aggregateLockSites(
        file,
        `sql\`SELECT id FROM items FOR UPDATE OF \${items}\``,
      ),
    ).toHaveLength(1);
    expect(
      aggregateLockSites(
        file,
        `sql\`SELECT 'FOR \${mode}' -- FOR \${mode}\nFROM items\``,
      ),
    ).toEqual([]);
  });
  test("static SQL lock lead-ins reject variable remainders", () => {
    for (const lead of [
      "FOR",
      "FOR NO",
      "FOR NO KEY",
      "FOR KEY",
      "pg_advisory",
      "pg_try_advisory",
    ]) {
      for (const source of [
        `sql.raw("${lead} " + mode)`,
        `sql.raw(\`${lead} \${mode}\`)`,
        `tx.execute("${lead} " + mode)`,
        `sql\`SELECT id FROM items ${lead} \${mode}\``,
      ]) {
        const actual = aggregateLockBaseline(aggregateLockSites(file, source));
        expect(actual).toHaveLength(1);
        expect(
          aggregateLockBaselineProblems({ actual, baseline: [] }),
        ).toContainEqual(expect.stringContaining("Unowned aggregate lock"));
      }
    }
    expect(
      aggregateLockSites(file, 'const message = "entry for " + mode'),
    ).toEqual([]);
    expect(aggregateLockSites(file, `sql.raw("SELECT 'FOR '" + mode)`)).toEqual(
      [],
    );
  });
  test("confines fragmented row locks to SQL contexts and excludes prose", () => {
    for (const source of [
      `const message = \`missing entry for \${id}\``,
      `const message = \`must await withAggregateLock for \${aggregate}\``,
    ]) {
      expect(aggregateLockSites(file, source)).toEqual([]);
    }
    for (const source of [
      `sql.raw(\`FOR \${mode}\`)`,
      `const query = \`SELECT id FROM items FOR \${mode}\``,
      `const query = \`SELECT pg_advisory_\${suffix}(1)\``,
    ]) {
      expect(aggregateLockSites(file, source)).toHaveLength(1);
    }
  });
});
