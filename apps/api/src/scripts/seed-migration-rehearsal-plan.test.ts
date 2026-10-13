import { expect, test } from "bun:test";

import { HIGH_VOLUME_TABLES } from "../db/high-volume-tables";
import {
  REHEARSAL_SEEDERS,
  REHEARSAL_SEED_ORDER,
  REHEARSAL_SEED_TABLES,
  rehearsalSeedSteps,
} from "./seed-migration-rehearsal-plan";

// Seeders use plain SQL. Ignore literal/comment contents and distinguish an
// upsert's UPDATE SET from a standalone UPDATE <table>.
const writeTargets = (statement: string) => {
  const executable = statement.replace(
    /'(?:''|[^'])*'|--[^\n]*|\/\*[\s\S]*?\*\//gu,
    " ",
  );
  return new Set(
    [
      ...executable.matchAll(
        /\b(?:INSERT\s+INTO|UPDATE(?!\s+SET\b)|DELETE\s+FROM|MERGE\s+INTO)\s+(?:public\.)?(?:"([a-z_][a-z_0-9]*)"|([a-z_][a-z_0-9]*))/giu,
      ),
    ].flatMap((match) => match[1] ?? match[2] ?? []),
  );
};

const undeclaredTargets = (statement: string, tables: readonly string[]) =>
  [...writeTargets(statement)].filter((table) => !tables.includes(table));

for (const [name, seeder] of Object.entries(REHEARSAL_SEEDERS)) {
  test(`${name} declares every SQL write target`, () => {
    const statement = seeder.statements(40).join(";\n");
    expect(writeTargets(statement).size).toBeGreaterThan(0);
    expect(seeder.tables).toContain(name);
    expect(undeclaredTargets(statement, seeder.tables)).toEqual([]);
    expect(statement).not.toMatch(/\b(?:to_regclass|EXECUTE|DO\s+\$)/iu);
  });
}

test("the write-target guard detects undeclared inserts and updates", () => {
  const statement = `
    INSERT INTO declared_table (id) VALUES ('UPDATE literal_table SET id = 1')
      ON CONFLICT (id) DO UPDATE SET id = 1;
    -- INSERT INTO comment_table VALUES (1);
    INSERT INTO public."missing_insert" VALUES (1);
    UPDATE "missing_update" SET id = 1;
  `;
  expect(undeclaredTargets(statement, ["declared_table"])).toEqual([
    "missing_insert",
    "missing_update",
  ]);
});

test("all declared tables present keeps every seeder in dependency order", () => {
  const steps = rehearsalSeedSteps(40, new Set(REHEARSAL_SEED_TABLES));
  expect(steps.filter((step) => step.type === "skip")).toEqual([]);
  expect(
    steps.flatMap((step) =>
      step.type === "sql" && step.table !== null ? [step.table] : [],
    ),
  ).toEqual(REHEARSAL_SEED_ORDER);
  expect(REHEARSAL_SEED_ORDER.length).toBe(HIGH_VOLUME_TABLES.length);
  expect(new Set(REHEARSAL_SEED_ORDER)).toEqual(new Set(HIGH_VOLUME_TABLES));
  expect(steps.at(-1)).toEqual({
    type: "vacuum",
    tables: REHEARSAL_SEED_ORDER,
  });
});

for (const absent of REHEARSAL_SEED_TABLES) {
  test(`missing ${absent} skips every seeder requiring it and excludes them from vacuum`, () => {
    const present = new Set(
      REHEARSAL_SEED_TABLES.filter((table) => table !== absent),
    );
    const steps = rehearsalSeedSteps(40, present);
    const skipped = Object.entries(REHEARSAL_SEEDERS).flatMap(
      ([table, seeder]) =>
        seeder.tables.some((target) => target === absent)
          ? [{ type: "skip", table, missingTables: [absent] }]
          : [],
    );
    expect(steps.filter((step) => step.type === "skip")).toEqual(skipped);
    const kept = REHEARSAL_SEED_ORDER.filter(
      (table) => !skipped.some((step) => step.table === table),
    );
    expect(
      steps.flatMap((step) =>
        step.type === "sql" && step.table !== null ? [step.table] : [],
      ),
    ).toEqual(kept);
    expect(steps.at(-1)).toEqual({ type: "vacuum", tables: kept });
  });
}

test("missing all write targets reports every missing table without an empty vacuum", () => {
  const steps = rehearsalSeedSteps(40, new Set());
  expect(steps.filter((step) => step.type === "skip")).toHaveLength(
    REHEARSAL_SEED_ORDER.length,
  );
  expect(steps.filter((step) => step.type === "vacuum")).toEqual([]);
  expect(
    steps.find(
      (step) =>
        step.type === "skip" && step.table === "case_law_provision_extractions",
    ),
  ).toEqual({
    type: "skip",
    table: "case_law_provision_extractions",
    missingTables: [
      "case_law_provision_extractions",
      "case_law_provision_extraction_scopes",
    ],
  });
});
