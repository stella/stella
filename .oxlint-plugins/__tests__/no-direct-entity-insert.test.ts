import { describe, expect, test } from "bun:test";

import { OWNERSHIP } from "../../scripts/ownership.ts";
import { lintSingleRule } from "./lint-single-rule.ts";

const SOURCE = [
  'import { entities as rows } from "@/api/db/schema";',
  'import * as schema from "@/api/db/schema/entities";',
  'tx.insert(rows).values({ name: "unresolved" });',
  'tx["insert"](schema.entities).values({ name: "unresolved" });',
  "tx.insert(otherTable);",
  "const local = (rows) => tx.insert(rows);",
  "",
].join("\n");

const lint = async (sourcePath: string) =>
  await lintSingleRule("no-direct-entity-insert", SOURCE, { sourcePath });

describe.serial("entity inserts use the named insert owner", () => {
  test("rejects new raw insert sites regardless of helper name or imported alias", async () => {
    expect(await lint("apps/api/src/lib/new-writer.ts")).toEqual([3, 4]);
  });
  test("rejects immutable aliases and schema destructuring without matching shadowed bindings", async () => {
    const source = [
      'import { entities } from "@/api/db/schema";',
      'import * as schema from "@/api/db/schema";',
      "const table = entities;",
      "const chained = table;",
      "const schemaAlias = schema;",
      "const { entities: extracted } = schemaAlias;",
      "tx.insert(table);",
      "tx.insert(chained);",
      "tx.insert(schemaAlias.entities);",
      "tx.insert(extracted);",
      'const tableAlias = schema["entities"];',
      "tx.insert(tableAlias);",
      "const { entities: renamed = fallback } = schema;",
      "tx.insert(renamed);",
      "const clean = (entities) => { const other = entities; tx.insert(other); };",
      "const { other: unrelated } = schema;",
      "tx.insert(unrelated);",
      "const cycleA = cycleB;",
      "const cycleB = cycleA;",
      "tx.insert(cycleA);",
    ].join("\n");
    expect(
      await lintSingleRule("no-direct-entity-insert", source, {
        sourcePath: "apps/api/src/lib/new-writer.ts",
      }),
    ).toEqual([7, 8, 9, 10, 12, 14]);
  });
  test("the pure name producer is confined to the sibling-set owner", async () => {
    const entries = OWNERSHIP.filter(
      ({ id }) => id === "entity-sibling-naming",
    );
    expect(entries).toHaveLength(1);
    const source = [
      'import { resolveSiblingName as pick } from "@/api/lib/entities/sibling-name";',
      'import * as naming from "@/api/lib/entities/sibling-name";',
      'export { resolveSiblingName } from "@/api/lib/entities/sibling-name";',
      'import type { ResolvedSiblingName } from "@/api/lib/entities/sibling-name";',
    ].join("\n");
    expect(
      await lintSingleRule("confine-owner", source, {
        sourcePath: "apps/api/src/lib/new-writer.ts",
        ruleOptions: { entries },
      }),
    ).toEqual([1, 2, 3]);
    expect(
      await lintSingleRule("confine-owner", source, {
        sourcePath: "apps/api/src/lib/entities/sibling-name-insert.ts",
        ruleOptions: { entries },
      }),
    ).toEqual([]);
  });
  test("allows typed owners and isolated database fixtures", async () => {
    expect(
      await lint("apps/api/src/lib/entities/sibling-name-insert.ts"),
    ).toEqual([]);
    expect(
      await lint("apps/api/src/lib/entity-versions/insert-entity-batch.ts"),
    ).toEqual([]);
    expect(await lint("apps/api/src/lib/writer.test.ts")).toEqual([]);
  });
});
