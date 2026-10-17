import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { censusOnlineDdlSource } from "./online-ddl-lock-census";

const ownerSource = readFileSync(
  path.resolve(import.meta.dir, "../apps/api/src/db/online-ddl.ts"),
  "utf-8",
);

describe("online DDL lock census", () => {
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
