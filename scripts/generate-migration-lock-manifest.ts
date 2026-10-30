#!/usr/bin/env bun
import { panic } from "better-result";
import path from "node:path";

import { compareCodeUnit } from "@stll/collation";
import { createSha256 } from "@stll/sha256/node";

import {
  MIGRATION_LOCK_MANIFEST_FILE,
  type MigrationLockManifest,
} from "../apps/api/src/db/migration-lock-manifest";
import { readMigrationLockSources } from "./check-migration-locks";
import {
  migrationStatementTokens,
  parseMigrationStatements,
  readMigrationRelation,
} from "./check-migration-safety";
import {
  formattedArtifactsLikeRepository,
  writeOrCheckArtifacts,
} from "./generated-artifacts";
import {
  migrationFolder,
  migrationRelationLocks,
  type MigrationSource,
} from "./migration-lock-census";

// Census relation keys encode schema/name without ambiguity for quoted identifiers.
const relationName = (target: string | undefined) => {
  if (target === undefined) {
    return "*";
  }
  const decoded: unknown = JSON.parse(target);
  if (!Array.isArray(decoded) || decoded.length !== 2) {
    return panic("Census returned a malformed relation key");
  }
  const [schema, name] = decoded;
  if (typeof schema !== "string" || typeof name !== "string") {
    return panic("Census returned a malformed relation name");
  }
  return schema === "public" ? name : `${schema}.${name}`;
};

export const generateMigrationLockManifest = (
  sources: readonly MigrationSource[],
): MigrationLockManifest => {
  const entries = new Map(
    migrationRelationLocks(sources).map(({ migration, locks }) => [
      migration,
      [
        ...new Map(
          locks.map(({ mode, target }) => {
            const relation = relationName(target);
            return [`${relation}/${mode}`, { relation, mode }];
          }),
        ).entries(),
      ]
        .toSorted(([left], [right]) => compareCodeUnit(left, right))
        .map(([, lock]) => lock),
    ]),
  );
  return {
    version: 1,
    migrations: Object.fromEntries(
      sources.map(({ file, source }) => {
        const migration = migrationFolder(file);
        return [
          migration,
          {
            hash: createSha256().update(source).digest("hex"),
            locks:
              entries.get(migration) ??
              panic(`Missing migration census: ${migration}`),
          },
        ];
      }),
    ),
  };
};

type TableTokens = ReturnType<typeof migrationStatementTokens>;
type TableRelation = NonNullable<
  ReturnType<typeof readMigrationRelation>
>["relation"];

type ApplyTableLifecycleOptions = {
  tables: Map<string, TableRelation>;
  tokens: TableTokens;
  position: number;
};

type ApplyTableIdentityChangeOptions = Pick<
  ApplyTableLifecycleOptions,
  "tables" | "tokens"
> & {
  target: NonNullable<ReturnType<typeof readMigrationRelation>>;
};

const applyTableIdentityChange = ({
  tables,
  tokens,
  target,
}: ApplyTableIdentityChangeOptions) => {
  const action = tokens[target.next]?.value;
  const detail = tokens[target.next + 1]?.value;
  if (action !== "rename" || detail !== "to") {
    if (action === "set" && detail === "schema") {
      const schema =
        readMigrationRelation(tokens, target.next + 2)?.relation.name ??
        panic("Migration table schema change has no target");
      tables.delete(target.relation.key);
      tables.set(JSON.stringify([schema, target.relation.name]), {
        ...target.relation,
        schema,
        key: JSON.stringify([schema, target.relation.name]),
      });
    }
    return;
  }
  const name =
    readMigrationRelation(tokens, target.next + 2)?.relation.name ??
    panic("Migration table rename has no target");
  tables.delete(target.relation.key);
  tables.set(JSON.stringify([target.relation.schema, name]), {
    ...target.relation,
    name,
    key: JSON.stringify([target.relation.schema, name]),
  });
  return;
};

const applyTableLifecycle = ({
  tables,
  tokens,
  position,
}: ApplyTableLifecycleOptions) => {
  const verb = tokens[position]?.value;
  let cursor = position + 1;
  if (
    verb === "create" &&
    /^(?:temp|temporary)$/u.test(tokens[cursor]?.value ?? "")
  ) {
    return;
  }
  if (verb === "create" && tokens[cursor]?.value === "unlogged") {
    cursor++;
  }
  if (tokens[cursor]?.value !== "table") {
    return;
  }
  cursor++;
  if (tokens[cursor]?.value === "if") {
    cursor += verb === "create" ? 3 : 2;
  }
  if (tokens[cursor]?.value === "only") {
    cursor++;
  }
  const target =
    readMigrationRelation(tokens, cursor) ??
    panic("Migration table declaration has no relation");
  switch (verb) {
    case "create":
      tables.set(target.relation.key, target.relation);
      return;
    case "drop": {
      let dropped: ReturnType<typeof readMigrationRelation> = target;
      while (dropped !== undefined) {
        tables.delete(dropped.relation.key);
        dropped =
          tokens[dropped.next]?.value === ","
            ? readMigrationRelation(tokens, dropped.next + 1)
            : undefined;
      }
      return;
    }
    case "alter":
      applyTableIdentityChange({ tables, tokens, target });
      return;
    default:
      return;
  }
};

/** Replay relation identities from committed DDL without loading runtime table handles. */
export const generateSchemaTableNames = (
  sources: readonly MigrationSource[],
) => {
  const tables = new Map<string, TableRelation>();
  for (const { source } of sources.toSorted((left, right) =>
    compareCodeUnit(left.file, right.file),
  )) {
    for (const statement of parseMigrationStatements(source)) {
      if (statement.deferred) {
        continue;
      }
      const tokens = migrationStatementTokens(statement);
      for (const [position, token] of tokens.entries()) {
        if (
          token.kind === "word" &&
          /^(?:create|drop|alter)$/u.test(token.value) &&
          (position === 0 ||
            /^(?:begin|then|else|loop)$/u.test(
              tokens[position - 1]?.value ?? "",
            ))
        ) {
          applyTableLifecycle({ tables, tokens, position });
        }
      }
    }
  }
  return [...tables.values()]
    .filter(({ schema }) => schema === "public")
    .map(({ name }) => name)
    .toSorted(compareCodeUnit);
};

if (import.meta.main) {
  const sources = readMigrationLockSources();
  const artifacts = await formattedArtifactsLikeRepository([
    {
      path: path.resolve(
        import.meta.dir,
        "../apps/api/drizzle",
        MIGRATION_LOCK_MANIFEST_FILE,
      ),
      contents: `${JSON.stringify(generateMigrationLockManifest(sources), null, 2)}\n`,
    },
    {
      path: path.resolve(
        import.meta.dir,
        "../apps/api/src/db/schema-table-names.gen.ts",
      ),
      contents: `// Generated by scripts/generate-migration-lock-manifest.ts.\nexport const SCHEMA_TABLE_NAMES = ${JSON.stringify(generateSchemaTableNames(sources), null, 2)} as const;\n`,
    },
  ]);
  process.exitCode = await writeOrCheckArtifacts(artifacts, {
    write: Bun.argv.includes("--write"),
    matched: "the migration relation lock census",
  });
}
