/**
 * Usage:
 *   bun src/scripts/database-census.ts snapshot --output <path> [--exclude <table,...>]
 *   bun src/scripts/database-census.ts compare --baseline <path> [--exclude <table,...>]
 *
 * Records, for every table in the public schema, the row count and (for
 * tables below a size bound) an order-independent content digest, plus a
 * referential-integrity sweep over every foreign key. `compare` fails when
 * any table outside the exclusion set differs from the baseline or any
 * foreign key has orphans. Only table names, counts, and digests are
 * emitted; no row content leaves the database.
 */

import { Result, TaggedError } from "better-result";
import { SQL } from "bun";
import { writeFile } from "node:fs/promises";
import * as v from "valibot";

import { hasSecureDatabaseTransport, resolveDatabaseUrl } from "@/api/db-url";
import { formatBetterAuthScriptFailure } from "@/api/scripts/better-auth-script-failure";

const EXIT_CODE = {
  CONFIGURATION_OR_QUERY_FAILURE: 2,
  DIFFERENCE: 1,
  SUCCESS: 0,
} as const;
// Tables above this estimated size get a count only; a content digest would
// scan the whole table on the clone.
const DIGEST_ROW_BOUND = 500_000;
const STATEMENT_TIMEOUT = "30min";

const censusSchema = v.strictObject({
  formatVersion: v.literal(1),
  foreignKeyOrphans: v.record(v.string(), v.string()),
  tables: v.record(
    v.string(),
    v.strictObject({
      digest: v.nullable(v.string()),
      rowCount: v.string(),
    }),
  ),
});
type Census = v.InferOutput<typeof censusSchema>;

class DatabaseCensusError extends TaggedError("DatabaseCensusError")<{
  cause?: unknown;
  code:
    | "baseline-unreadable"
    | "database-query-failed"
    | "invalid-arguments"
    | "output-write-failed";
  message: string;
}> {}

type CensusCommand =
  | { exclude: ReadonlySet<string>; mode: "snapshot"; outputPath: string }
  | { baselinePath: string; exclude: ReadonlySet<string>; mode: "compare" };

export const parseDatabaseCensusArgs = (
  args: readonly string[],
): Result<CensusCommand, DatabaseCensusError> => {
  const invalid = () =>
    Result.err(
      new DatabaseCensusError({
        code: "invalid-arguments",
        message:
          "Usage: database-census snapshot --output <path> [--exclude a,b] | compare --baseline <path> [--exclude a,b]",
      }),
    );
  const [mode, pathFlag, path, ...rest] = args;
  if (!path || (rest.length !== 0 && rest.length !== 2)) {
    return invalid();
  }
  let exclude: ReadonlySet<string> = new Set();
  if (rest.length === 2) {
    if (rest[0] !== "--exclude" || !rest[1]) {
      return invalid();
    }
    exclude = new Set(rest[1].split(",").filter((name) => name.length > 0));
  }
  if (mode === "snapshot" && pathFlag === "--output") {
    return Result.ok({ exclude, mode, outputPath: path });
  }
  if (mode === "compare" && pathFlag === "--baseline") {
    return Result.ok({ baselinePath: path, exclude, mode });
  }
  return invalid();
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const queryFailed = (cause: unknown) =>
  new DatabaseCensusError({
    cause,
    code: "database-query-failed",
    message: "Database census query failed",
  });

const readCensus = async (
  sql: SQL,
): Promise<Result<Census, DatabaseCensusError>> => {
  const tablesQueried = await Result.tryPromise({
    try: async () => {
      await sql`SELECT set_config('statement_timeout', ${STATEMENT_TIMEOUT}, false)`;
      return await sql`
        SELECT c.relname AS "name", c.reltuples::bigint AS "estimate"
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'r'
         ORDER BY c.relname
      `;
    },
    catch: queryFailed,
  });
  if (Result.isError(tablesQueried)) {
    return tablesQueried;
  }
  // One connection, one table at a time: the digest scans are the heavy part
  // and must not contend with each other on the clone.
  const tables: Census["tables"] = {};
  const tableRows = tablesQueried.value.values();
  const measureNextTable = async (): Promise<
    Result<undefined, DatabaseCensusError>
  > => {
    const next = tableRows.next();
    if (next.done) {
      return Result.ok(undefined);
    }
    const row: unknown = next.value;
    if (!isRecord(row) || typeof row["name"] !== "string") {
      return Result.err(queryFailed(undefined));
    }
    const name = row["name"];
    const estimate = Number(row["estimate"]);
    const digestWanted = estimate >= 0 && estimate <= DIGEST_ROW_BOUND;
    const measured = await Result.tryPromise({
      try: async () =>
        digestWanted
          ? await sql`
              SELECT count(*)::text AS "rowCount",
                     md5(coalesce(string_agg(md5(t::text), '' ORDER BY md5(t::text)), '')) AS "digest"
                FROM ${sql(name)} t
            `
          : await sql`SELECT count(*)::text AS "rowCount", NULL AS "digest" FROM ${sql(name)}`,
      catch: queryFailed,
    });
    if (Result.isError(measured)) {
      return measured;
    }
    const first: unknown = measured.value.at(0);
    if (
      !isRecord(first) ||
      typeof first["rowCount"] !== "string" ||
      (first["digest"] !== null && typeof first["digest"] !== "string")
    ) {
      return Result.err(queryFailed(undefined));
    }
    tables[name] = { digest: first["digest"], rowCount: first["rowCount"] };
    return measureNextTable();
  };
  const tablesMeasured = await measureNextTable();
  if (Result.isError(tablesMeasured)) {
    return tablesMeasured;
  }

  const foreignKeysQueried = await Result.tryPromise({
    try: async () =>
      await sql`
      SELECT con.conname AS "name",
             child.relname AS "childTable",
             parent.relname AS "parentTable",
             array_agg(childCol.attname ORDER BY ord.n) AS "childColumns",
             array_agg(parentCol.attname ORDER BY ord.n) AS "parentColumns"
        FROM pg_constraint con
        JOIN pg_class child ON child.oid = con.conrelid
        JOIN pg_class parent ON parent.oid = con.confrelid
        JOIN pg_namespace n ON n.oid = child.relnamespace
        JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS ord(childAttnum, parentAttnum, n) ON true
        JOIN pg_attribute childCol ON childCol.attrelid = child.oid AND childCol.attnum = ord.childAttnum
        JOIN pg_attribute parentCol ON parentCol.attrelid = parent.oid AND parentCol.attnum = ord.parentAttnum
       WHERE con.contype = 'f' AND n.nspname = 'public'
       GROUP BY con.conname, child.relname, parent.relname
       ORDER BY con.conname
    `,
    catch: queryFailed,
  });
  if (Result.isError(foreignKeysQueried)) {
    return foreignKeysQueried;
  }
  const foreignKeyOrphans: Census["foreignKeyOrphans"] = {};
  const foreignKeyRows = foreignKeysQueried.value.values();
  const sweepNextForeignKey = async (): Promise<
    Result<undefined, DatabaseCensusError>
  > => {
    const next = foreignKeyRows.next();
    if (next.done) {
      return Result.ok(undefined);
    }
    const row: unknown = next.value;
    if (
      !isRecord(row) ||
      typeof row["name"] !== "string" ||
      typeof row["childTable"] !== "string" ||
      typeof row["parentTable"] !== "string" ||
      !Array.isArray(row["childColumns"]) ||
      !Array.isArray(row["parentColumns"])
    ) {
      return Result.err(queryFailed(undefined));
    }
    const childColumns = row["childColumns"].map(String);
    const parentColumns = row["parentColumns"].map(String);
    const childTable = row["childTable"];
    const parentTable = row["parentTable"];
    const orphans = await Result.tryPromise({
      try: async () => {
        const notNull = childColumns
          .map((column) => `c.${quoteIdentifier(column)} IS NOT NULL`)
          .join(" AND ");
        const join = childColumns
          .map(
            (column, index) =>
              `p.${quoteIdentifier(parentColumns[index] ?? column)} = c.${quoteIdentifier(column)}`,
          )
          .join(" AND ");
        return await sql.unsafe(
          `SELECT count(*)::text AS "orphans" FROM ${quoteIdentifier(childTable)} c WHERE ${notNull} AND NOT EXISTS (SELECT 1 FROM ${quoteIdentifier(parentTable)} p WHERE ${join})`,
        );
      },
      catch: queryFailed,
    });
    if (Result.isError(orphans)) {
      return orphans;
    }
    const first = orphans.value.at(0);
    if (!isRecord(first) || typeof first["orphans"] !== "string") {
      return Result.err(queryFailed(undefined));
    }
    foreignKeyOrphans[row["name"]] = first["orphans"];
    return sweepNextForeignKey();
  };
  const foreignKeysSwept = await sweepNextForeignKey();
  if (Result.isError(foreignKeysSwept)) {
    return foreignKeysSwept;
  }

  return Result.ok({ foreignKeyOrphans, formatVersion: 1, tables });
};

// Identifiers come from the catalog, never from input, and are still quoted
// so a table named with unusual characters cannot alter the statement.
const quoteIdentifier = (identifier: string) =>
  `"${identifier.replaceAll('"', '""')}"`;

type CensusDifference = {
  foreignKeyOrphans: string[];
  tables: { metric: "digest" | "rowCount" | "presence"; table: string }[];
};

export const compareCensus = (
  baseline: Census,
  current: Census,
  exclude: ReadonlySet<string>,
): CensusDifference => {
  const differences: CensusDifference = { foreignKeyOrphans: [], tables: [] };
  const names = new Set([
    ...Object.keys(baseline.tables),
    ...Object.keys(current.tables),
  ]);
  for (const table of [...names].toSorted()) {
    if (exclude.has(table)) {
      continue;
    }
    const before = baseline.tables[table];
    const after = current.tables[table];
    if (before === undefined || after === undefined) {
      differences.tables.push({ metric: "presence", table });
      continue;
    }
    if (before.rowCount !== after.rowCount) {
      differences.tables.push({ metric: "rowCount", table });
    } else if (before.digest !== after.digest) {
      differences.tables.push({ metric: "digest", table });
    }
  }
  for (const [name, orphans] of Object.entries(current.foreignKeyOrphans)) {
    if (orphans !== "0") {
      differences.foreignKeyOrphans.push(name);
    }
  }
  return differences;
};

const run = async (
  args: readonly string[],
): Promise<Result<CensusDifference | undefined, DatabaseCensusError>> => {
  const parsed = parseDatabaseCensusArgs(args);
  if (Result.isError(parsed)) {
    return parsed;
  }
  const databaseUrl = resolveDatabaseUrl();
  if (!databaseUrl || !hasSecureDatabaseTransport(databaseUrl)) {
    return Result.err(
      new DatabaseCensusError({
        code: "invalid-arguments",
        message: "Database census requires a secure database connection",
      }),
    );
  }
  const sql = new SQL({ max: 1, url: databaseUrl });
  const census = await readCensus(sql);
  await sql.end();
  if (Result.isError(census)) {
    return census;
  }
  const command = parsed.value;
  if (command.mode === "snapshot") {
    const written = await Result.tryPromise({
      try: async () =>
        await writeFile(
          command.outputPath,
          `${JSON.stringify(census.value)}\n`,
          { encoding: "utf-8", flag: "wx", mode: 0o600 },
        ),
      catch: (cause) =>
        new DatabaseCensusError({
          cause,
          code: "output-write-failed",
          message: "Database census could not be written",
        }),
    });
    if (Result.isError(written)) {
      return written;
    }
    return Result.ok(undefined);
  }
  const baseline = await Result.tryPromise({
    try: async () =>
      v.parse(censusSchema, await Bun.file(command.baselinePath).json()),
    catch: (cause) =>
      new DatabaseCensusError({
        cause,
        code: "baseline-unreadable",
        message: "Database census baseline is unreadable",
      }),
  });
  if (Result.isError(baseline)) {
    return baseline;
  }
  return Result.ok(
    compareCensus(baseline.value, census.value, command.exclude),
  );
};

if (import.meta.main) {
  run(Bun.argv.slice(2))
    .then((result) => {
      if (Result.isError(result)) {
        process.stderr.write(formatBetterAuthScriptFailure(result.error));
        process.exitCode = EXIT_CODE.CONFIGURATION_OR_QUERY_FAILURE;
        return undefined;
      }
      const differences = result.value;
      if (differences === undefined) {
        process.stdout.write(
          `${JSON.stringify({ check: "database-census", status: "recorded" })}\n`,
        );
        process.exitCode = EXIT_CODE.SUCCESS;
        return undefined;
      }
      const clean =
        differences.tables.length === 0 &&
        differences.foreignKeyOrphans.length === 0;
      process.stdout.write(
        `${JSON.stringify({
          check: "database-census",
          differences,
          status: clean ? "passed" : "failed",
        })}\n`,
      );
      process.exitCode = clean ? EXIT_CODE.SUCCESS : EXIT_CODE.DIFFERENCE;
      return undefined;
    })
    .catch((error: unknown) => {
      process.stderr.write(
        formatBetterAuthScriptFailure({
          cause: error,
          code: "unexpected-failure",
          message: "Database census failed unexpectedly",
        }),
      );
      process.exitCode = EXIT_CODE.CONFIGURATION_OR_QUERY_FAILURE;
    });
}
