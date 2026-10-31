#!/usr/bin/env bun

// Whether a change reaches the database schema through an import. Enum values
// and constraint vocabularies live outside the migration paths (in API
// libraries and workspace packages), so changing one changes the generated
// DDL without touching a schema file; the migration jobs, whose schema parity
// check catches a missing migration, must run for it.

import { panic } from "better-result";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import { buildImportGraph } from "./api-test-impact";

const DRIZZLE_CONFIG = "apps/api/drizzle.config.ts";
const SCHEMA_LIST = /schema\s*:\s*\[(?<list>[^\]]*)\]/u;
const QUOTED_SOURCE = /["'`](?<file>[^"'`]+\.ts)["'`]/gu;

/** The schema files drizzle-kit reads, repository-relative, from its config. */
export const schemaEntries = (root: string): string[] => {
  const list =
    SCHEMA_LIST.exec(readFileSync(path.join(root, DRIZZLE_CONFIG), "utf-8"))
      ?.groups?.["list"] ?? panic(`${DRIZZLE_CONFIG} lists no schema files`);
  const entries = [...list.matchAll(QUOTED_SOURCE)].flatMap(({ groups }) =>
    groups?.["file"] === undefined
      ? []
      : [path.posix.normalize(path.posix.join("apps/api", groups["file"]))],
  );
  if (entries.length === 0) {
    panic(`${DRIZZLE_CONFIG} lists no schema files`);
  }
  return entries;
};

type SchemaImportsChangedOptions = {
  root: string;
  /** Repository-relative changed paths. */
  changed: readonly string[];
};

/** A module the graph could not read counts as reaching the schema. */
export const schemaImportsChanged = ({
  root,
  changed,
}: SchemaImportsChangedOptions): boolean => {
  const entries = schemaEntries(root);
  const graph = buildImportGraph(root, entries);
  if (graph.failed.size > 0) {
    return true;
  }
  const closure = new Set(
    entries.flatMap((entry) => [...graph.closure(entry)]),
  );
  return changed.some((file) => closure.has(file));
};

if (import.meta.main) {
  // The planner's NUL-separated changed paths; a file avoids the environment
  // size limit a large change would exceed.
  const changedPaths = v.parse(v.string(), process.env["CHANGED_PATHS"]);
  const changed = readFileSync(changedPaths, "utf-8")
    .split("\0")
    .filter((file) => file.length > 0);
  const root = path.resolve(import.meta.dir, "..");
  console.log(`changed=${String(schemaImportsChanged({ root, changed }))}`);
}
