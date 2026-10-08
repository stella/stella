import { describe, expect, test } from "bun:test";

import {
  aggregateLockBaseline,
  aggregateLockBaselineProblems,
  aggregateLockSites,
} from "../aggregate-lock-sites.ts";

const file = "apps/api/src/handlers/example.ts";
describe("aggregate lock confinement", () => {
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
