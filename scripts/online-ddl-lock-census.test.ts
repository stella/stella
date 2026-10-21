import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  censusOnlineDdlSource,
  TEMPLATE_INTERPOLATION_ALLOWLIST,
} from "./online-ddl-lock-census";

const ownerSource = readFileSync(
  path.resolve(import.meta.dir, "../apps/api/src/db/online-ddl.ts"),
  "utf-8",
);

describe("online DDL lock census", () => {
  test("the interpolation allowlist remains explicit and counted", () => {
    expect(
      TEMPLATE_INTERPOLATION_ALLOWLIST.map(({ shape, reason }) => ({
        shape,
        reason,
      })),
    ).toEqual([
      {
        shape: "quoteIdentifier(...) call",
        reason:
          "quoteIdentifier returns one validated, double-quoted PostgreSQL identifier.",
      },
      {
        shape: "conditional with literal-only branches",
        reason:
          "Literal branches are enumerated independently and cannot inject uninspected SQL.",
      },
    ]);
  });

  test("the online DDL owner classifies each gated SQL variant", () => {
    expect(censusOnlineDdlSource(ownerSource)).toEqual([]);
  });

  test("unknown DDL in a gated SQL template fails the census", () => {
    const source = `${ownerSource}\nconst fixture = lockTaking("probe", \`CREATE MATERIALIZED VIEW probe_view AS SELECT 1\`);`;
    expect(censusOnlineDdlSource(source).join("\n")).toMatch(
      /unknown|unclassified|unsupported/iu,
    );
  });

  test("an ungated ACCESS EXCLUSIVE table alteration fails the census", () => {
    const source = `${ownerSource}\nconst fixture = \`ALTER TABLE public.probe ADD COLUMN added text\`;`;
    expect(censusOnlineDdlSource(source).join("\n")).toMatch(
      /ACCESS EXCLUSIVE.*lockTaking/iu,
    );
  });

  test("the dynamic create SQL exception is scoped to its checked builder", () => {
    const source = `${ownerSource}\nconst fixture = lockTaking("probe", createSql);`;
    expect(censusOnlineDdlSource(source).join("\n")).toMatch(
      /createSql pass-through lacks an anchored concurrent-index AST proof/iu,
    );
  });

  test("every lock-taking conditional branch must resolve to literal SQL", () => {
    const source = `${ownerSource}\nconst fixture = lockTaking("probe", condition ? "ALTER TABLE probe ADD COLUMN added text" : suppliedSql);`;
    expect(censusOnlineDdlSource(source).join("\n")).toMatch(
      /lockTaking SQL argument .* unresolved SQL variant/iu,
    );
  });

  test("a template substitution is unresolved even when its value could contain SQL", () => {
    const source = `${ownerSource}\nconst fixture = lockTaking("probe", \`ALTER TABLE probe ADD COLUMN added text \${suppliedSql}\`);`;
    expect(censusOnlineDdlSource(source).join("\n")).toMatch(
      /lockTaking SQL argument .* unresolved SQL variant/iu,
    );
  });

  test("a raw string interpolation is unresolved", () => {
    const source = `${ownerSource}\nconst rawSql = "NOT NULL; DROP TABLE probe";\nconst fixture = lockTaking("probe", \`ALTER TABLE probe ADD COLUMN added text \${rawSql}\`);`;
    expect(censusOnlineDdlSource(source).join("\n")).toMatch(
      /lockTaking SQL argument .* unresolved SQL variant/iu,
    );
  });

  test("the quoted-identifier interpolation allowance resolves", () => {
    const source = `${ownerSource}\nconst fixture = lockTaking("probe", \`ANALYZE public.\${quoteIdentifier(tableName)}\`);`;
    expect(censusOnlineDdlSource(source)).toEqual([]);
  });

  test("the literal-branch interpolation allowance resolves every branch", () => {
    const source = `${ownerSource}\nconst fixture = lockTaking("probe", \`DROP INDEX CONCURRENTLY \${ifExists ? "IF EXISTS " : ""}public.probe_idx\`);`;
    expect(censusOnlineDdlSource(source)).toEqual([]);
  });

  test("a fully literal lock-taking conditional classifies every branch", () => {
    const source = `${ownerSource}\nconst fixture = lockTaking("probe", condition ? "ALTER TABLE probe ADD COLUMN first text" : "ALTER TABLE probe ADD COLUMN second text");`;
    expect(censusOnlineDdlSource(source)).toEqual([]);
  });

  test("every resolved lock-taking conditional branch must be classified", () => {
    const source = `${ownerSource}\nconst fixture = lockTaking("probe", condition ? "ALTER TABLE probe ADD COLUMN added text" : "SELECT 1; CREATE MATERIALIZED VIEW hidden AS SELECT 1;");`;
    expect(censusOnlineDdlSource(source).join("\n")).toMatch(
      /unclassified SQL statement: SELECT 1/iu,
    );
  });

  test("every statement in a lock-taking literal must be classified", () => {
    const source = `${ownerSource}\nconst fixture = lockTaking("probe", "ALTER TABLE probe ADD COLUMN first text; ALTER TABLE probe ADD COLUMN second text;");`;
    expect(censusOnlineDdlSource(source)).toEqual([]);
  });

  test("the private statement brand cannot be manufactured with a cast", () => {
    const source = `${ownerSource}\nconst counterfeit = {} as LockTakingStatement;`;
    expect(censusOnlineDdlSource(source).join("\n")).toMatch(
      /LockTakingStatement must be constructed by lockTaking/iu,
    );
  });

  test("table sessions cannot be constructed outside the approved gates", () => {
    const source = `${ownerSource}\nconst fixture = sessionOn(connection, target).run(async () => {});`;
    expect(censusOnlineDdlSource(source).join("\n")).toMatch(
      /sessionOn .* is outside runGatedTableWork or createUngatedTableGateForTests/iu,
    );
  });

  test("gated table work must use the connection passed to runtime.attempt", () => {
    const source = ownerSource.replace(
      "sessionOn(guardedConnection, target)",
      "sessionOn(connection, target)",
    );
    expect(source).not.toBe(ownerSource);
    expect(censusOnlineDdlSource(source).join("\n")).toMatch(
      /sessionOn .* must use the guarded runtime\.attempt connection/iu,
    );
  });
});
