import { expect, test } from "bun:test";
import { getColumns, is } from "drizzle-orm";
import { getTableConfig, PgDialect, PgTable } from "drizzle-orm/pg-core";
import path from "node:path";

import { treeBaseRevision } from "@stll/scripts/src/tree-base-revision";

import { TRANSITIONS } from "@/api/lib/db/transition-specs";
import { isRecord } from "@/api/lib/type-guards";

import undeclared from "./state-fields-undeclared.json";

const repoRoot = path.resolve(import.meta.dir, "../../../../..");
const BASELINE_PATH = "apps/api/src/lib/db/state-fields-undeclared.json";
const dialect = new PgDialect();

const specsOf = (decision: unknown): readonly unknown[] =>
  isRecord(decision) && isRecord(decision["scoped"])
    ? Object.values(decision["scoped"])
    : [decision];

const stateKeysOf = (spec: Record<string, unknown>): string[] => {
  if (spec["kind"] === "lifecycle" && isRecord(spec["graphs"])) {
    return Object.keys(spec["graphs"]);
  }
  return typeof spec["stateColumn"] === "string"
    ? [spec["stateColumn"]]
    : ["status"];
};

/**
 * Managed tables with no CHECK that names a state column and tests a column
 * for null: their states may carry fields nothing binds to them.
 */
const tablesWithoutStateFields = () =>
  Object.entries(TRANSITIONS).flatMap(([name, decision]) => {
    if (isRecord(decision) && "unmanaged" in decision) {
      return [];
    }
    const specs = specsOf(decision).filter(isRecord);
    const table = specs.at(0)?.["table"];
    if (
      !is(table, PgTable) ||
      specs.every((spec) => spec["kind"] === "fixed")
    ) {
      return [];
    }
    const columns = getColumns(table);
    const stateNames = specs.flatMap(stateKeysOf).flatMap((key) => {
      const column = Object.entries(columns).find(([k]) => k === key)?.[1];
      return column === undefined ? [] : [column.name];
    });
    const declared = getTableConfig(table).checks.some(({ value }) => {
      // Hand-written CHECKs name columns bare or quoted; compare bare words.
      const words = new Set(
        dialect.sqlToQuery(value).sql.replaceAll('"', " ").split(/\W+/u),
      );
      return (
        stateNames.some((stateName) => words.has(stateName)) &&
        /IS (?:NOT )?NULL/u.test(dialect.sqlToQuery(value).sql)
      );
    });
    return declared ? [] : [name];
  });

test("every managed lifecycle declares what its states carry, or is listed as not yet declared", () => {
  expect(tablesWithoutStateFields().toSorted()).toEqual(
    [...undeclared.tables].toSorted(),
  );
});

test("the not-yet-declared list only shrinks from the merge base", () => {
  const revision = treeBaseRevision({ repoRoot });
  const present = Bun.spawnSync(
    ["git", "ls-tree", "--name-only", revision, BASELINE_PATH],
    { cwd: repoRoot },
  );
  expect(present.exitCode).toBe(0);
  // The introducing change establishes the list; later changes only remove.
  if (new TextDecoder().decode(present.stdout).trim() === "") {
    return;
  }
  const prior = Bun.spawnSync(["git", "show", `${revision}:${BASELINE_PATH}`], {
    cwd: repoRoot,
  });
  expect(prior.exitCode).toBe(0);
  const parsed: unknown = JSON.parse(new TextDecoder().decode(prior.stdout));
  const priorTables =
    isRecord(parsed) && Array.isArray(parsed["tables"]) ? parsed["tables"] : [];
  expect(
    undeclared.tables.filter((table) => !priorTables.includes(table)),
  ).toEqual([]);
});
