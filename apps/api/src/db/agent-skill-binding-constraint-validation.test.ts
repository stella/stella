import { panic } from "better-result";
import { expect, test } from "bun:test";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { readFileSync } from "node:fs";

import { parseMigrationStatements } from "../../../../scripts/check-migration-safety";
import {
  AGENT_SKILL_BINDING_CONSTRAINT_VALIDATIONS,
  AGENT_SKILL_BINDING_CONSTRAINTS,
} from "./agent-skill-binding-constraint-validation";
import {
  ONLINE_CONSTRAINT_VALIDATIONS,
  ONLINE_MIGRATION_INDEXES,
  ONLINE_MIGRATION_REPAIRS,
} from "./online-migrations";
import { agentSkills } from "./schema/skills";

test("every skill binding constraint is added without validation and registered for gated online validation", () => {
  const statements = parseMigrationStatements(
    readFileSync(
      new URL(
        "../../drizzle/20261016100500_agent_skill_binding/migration.sql",
        import.meta.url,
      ),
      "utf-8",
    ),
  );
  const declarations = statements.flatMap(({ raw }) => {
    const match =
      /^ALTER\s+TABLE\s+"([^"]+)"\s+ADD\s+CONSTRAINT\s+"([^"]+)"/iu.exec(raw);
    if (match === null) {
      return [];
    }
    expect(raw).toMatch(/\bNOT\s+VALID\b/iu);
    return [
      {
        tableName: match.at(1) ?? panic("Constraint has no table"),
        constraintName: match.at(2) ?? panic("Constraint has no name"),
      },
    ];
  });
  expect(declarations).toEqual([...AGENT_SKILL_BINDING_CONSTRAINTS]);
  expect(
    statements.some(({ text }) => /\bVALIDATE\s+CONSTRAINT\b/iu.test(text)),
  ).toBe(false);
  for (const constraint of AGENT_SKILL_BINDING_CONSTRAINTS) {
    expect(ONLINE_CONSTRAINT_VALIDATIONS).toContain(constraint);
  }
  for (const repair of AGENT_SKILL_BINDING_CONSTRAINT_VALIDATIONS) {
    expect(ONLINE_MIGRATION_REPAIRS).toContain(repair);
  }
});

test("the schema's binding indexes are built concurrently by the online owner", () => {
  const table = getTableConfig(agentSkills);
  const bindingColumns = new Set([
    agentSkills.boundWorkspaceId.name,
    agentSkills.boundClientId.name,
  ]);
  const indexes = table.indexes.filter(({ config }) =>
    config.columns.some(
      (column) => "name" in column && bindingColumns.has(column.name),
    ),
  );
  expect(indexes).toHaveLength(bindingColumns.size);
  for (const { config } of indexes) {
    const declaration = ONLINE_MIGRATION_INDEXES.find(
      ({ name }) => name === config.name,
    );
    if (declaration === undefined || config.where === undefined) {
      panic("A partial skill binding index has no online declaration");
    }
    expect(declaration.tableName).toBe(table.name);
    expect(declaration.isUnique).toBe(config.unique);
    expect(declaration.createSql).toContain("CREATE INDEX CONCURRENTLY");
    expect(declaration.definitionBody).toContain(
      new PgDialect().sqlToQuery(config.where).sql,
    );
  }
});
