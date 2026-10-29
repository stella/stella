import { panic } from "better-result";
import { is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { repoRelativePath } from "@stll/portable-path";

import {
  entityFeatureGateMetadata,
  entityFeatureGatePropagationSql,
} from "../src/db/entity-feature-gate-metadata";
import type { EntityFeatureGateDescriptor } from "../src/db/entity-feature-gate-metadata";
import * as schema from "../src/db/schema";

/** Replace only the two generated routines; migration-specific fences remain intact. */
export const updateEntityFeatureGateMigration = (
  migration: string,
  descriptors: readonly EntityFeatureGateDescriptor[],
) => {
  const graph = Object.fromEntries(
    descriptors.map((descriptor, order) => [
      descriptor.tableName,
      { ...descriptor, order },
    ]),
  );
  const graphSql = `CREATE OR REPLACE FUNCTION public.entity_feature_gate_graph() RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $graph$ SELECT $metadata$${JSON.stringify(graph)}$metadata$::jsonb $graph$;`;
  const replacements = [
    {
      pattern:
        /CREATE OR REPLACE FUNCTION public\.entity_feature_gate_graph\(\)[\s\S]+?\$graph\$;/gu,
      sql: graphSql,
    },
    {
      pattern:
        /CREATE OR REPLACE FUNCTION public\.entity_feature_gate_propagate\(\)[\s\S]+?\$function\$;/gu,
      sql: entityFeatureGatePropagationSql(descriptors),
    },
  ];
  let updated = migration;
  for (const replacement of replacements) {
    if ([...updated.matchAll(replacement.pattern)].length !== 1) {
      panic(
        "Expected exactly one generated entity feature routine",
        replacement.pattern.source,
      );
    }
    updated = updated.replace(replacement.pattern, () => replacement.sql);
  }
  return updated;
};

if (import.meta.main) {
  const tables = Object.values(schema).filter((table) => is(table, PgTable));
  const descriptors = entityFeatureGateMetadata(tables);
  const args = Bun.argv.slice(2);
  if (args.length === 0) {
    // Print for a new migration; merged migration files are immutable.
    process.stdout.write(`${entityFeatureGatePropagationSql(descriptors)}\n`);
  } else {
    const [mode, migrationPath] = args;
    if (
      args.length !== 2 ||
      (mode !== "--write-migration" && mode !== "--check-migration") ||
      migrationPath === undefined
    ) {
      panic(
        "Usage: generate-entity-feature-gate-propagation.ts [--write-migration|--check-migration apps/api/drizzle/<migration>/migration.sql]",
      );
    }
    const repoRoot = path.resolve(import.meta.dir, "../../..");
    const relativePath = repoRelativePath(
      repoRoot,
      path.resolve(repoRoot, migrationPath),
    );
    if (
      !/^apps\/api\/drizzle\/\d{14}_[a-z0-9_]+\/migration\.sql$/u.test(
        relativePath,
      )
    ) {
      panic("Expected a repository migration.sql path", migrationPath);
    }
    if (mode === "--write-migration") {
      const merged = execFileSync(
        "git",
        [
          "ls-tree",
          "-r",
          "--name-only",
          "origin/main",
          "--",
          path.dirname(relativePath),
        ],
        { cwd: repoRoot, encoding: "utf-8", maxBuffer: 32 * 1024 * 1024 },
      );
      if (merged.trim() !== "") {
        panic(
          "Cannot regenerate a migration already present on origin/main",
          relativePath,
        );
      }
    }
    const absolutePath = path.join(repoRoot, relativePath);
    const current = readFileSync(absolutePath, "utf-8");
    const generated = updateEntityFeatureGateMigration(current, descriptors);
    if (mode === "--write-migration") {
      writeFileSync(absolutePath, generated);
    } else if (current !== generated) {
      panic(
        "Entity feature migration does not match canonical schema metadata",
        relativePath,
      );
    }
  }
}
