import { panic } from "better-result";
import * as v from "valibot";

import { initialBatchState } from "@stll/db-load-gate/health";

import { CASE_LAW_FILING_YEAR_FUNCTION_SIGNATURE } from "@/api/lib/case-law/coverage-index";

import { decodeCheckpoint } from "./backfill-runtime";
import { reindexIndexConcurrently } from "./online-ddl";
import type {
  OnlineMigrationConnection,
  OnlineRepair,
} from "./online-migration-connection";

// Earlier replacements were audited on 2026-10-30; one index rebuild is handled separately.
export const FUNCTION_REPLACEMENT_GUARD_FROM_REVISION = "20261029175101";

const dependentIndexSchema = v.object({
  name: v.string(),
  tableName: v.string(),
});
const progressSchema = v.object({
  indexes: v.array(dependentIndexSchema),
  status: v.picklist(["pending", "complete"]),
});

/** Expressions and predicates both register their function dependency in pg_depend. */
export const readFunctionDependentIndexes = async (
  connection: Pick<OnlineMigrationConnection, "query">,
  functionSignature: string,
) => {
  const rows = await connection.query(
    `
    SELECT DISTINCT index_relation.relname AS name, table_relation.relname AS "tableName",
      index_namespace.nspname AS "schemaName"
    FROM pg_catalog.pg_depend dependency
    JOIN pg_catalog.pg_index index_state ON index_state.indexrelid = dependency.objid
    JOIN pg_catalog.pg_class index_relation ON index_relation.oid = index_state.indexrelid
    JOIN pg_catalog.pg_namespace index_namespace ON index_namespace.oid = index_relation.relnamespace
    JOIN pg_catalog.pg_class table_relation ON table_relation.oid = index_state.indrelid
    JOIN pg_catalog.pg_proc function ON function.oid = dependency.refobjid
    WHERE dependency.classid = 'pg_catalog.pg_class'::regclass
      AND dependency.refclassid = 'pg_catalog.pg_proc'::regclass
      AND function.oid = to_regprocedure($1)
      AND function.provolatile = 'i'
    ORDER BY name, "tableName"
  `,
    [functionSignature],
  );
  const parsed = v.safeParse(
    v.array(
      v.object({
        name: v.string(),
        tableName: v.string(),
        schemaName: v.string(),
      }),
    ),
    rows,
  );
  if (!parsed.success) {
    return panic("Invalid dependent-index catalog result");
  }
  return parsed.output.map(({ name, tableName, schemaName }) => {
    if (schemaName !== "public") {
      return panic("Online index DDL requires a public-schema dependent index");
    }
    return { name, tableName };
  });
};

const readProgress = async (
  connection: OnlineMigrationConnection,
  name: string,
) => {
  const row = (
    await connection.query(
      "SELECT cursor, batch FROM public.database_backfill_states WHERE name = $1",
      [name],
    )
  ).at(0);
  if (row === undefined) {
    return undefined;
  }
  const checkpoint = decodeCheckpoint(row);
  const progress = v.safeParse(
    v.object({ batch: v.object({ reindex: progressSchema }) }),
    row,
  );
  if (!progress.success) {
    return panic("Invalid function-index reindex checkpoint");
  }
  const { indexes, status } = progress.output.batch.reindex;
  if (
    checkpoint.cursor !== null &&
    !indexes.some(({ name: indexName }) => indexName === checkpoint.cursor)
  ) {
    return panic(
      "Function-index reindex cursor is outside its catalog workset",
    );
  }
  return {
    cursor: checkpoint.cursor,
    batch: checkpoint.batch,
    indexes,
    status,
  };
};

type FunctionDependentIndexReindexOptions = {
  functionSignature: string;
  replacementRevision: string;
};

/** A retry repeats at most the last rebuild if it ended before its checkpoint write. */
export const createFunctionDependentIndexReindex = ({
  functionSignature,
  replacementRevision,
}: FunctionDependentIndexReindexOptions) => {
  const name = `function-dependent-index-reindex:${functionSignature}`;
  const checkpointName = `${name}:${replacementRevision}`;
  return {
    name,
    functionSignature,
    introducedBy: replacementRevision,
    readCompletion: async (connection) => {
      const progress = await readProgress(connection, checkpointName);
      return progress?.status === "complete"
        ? { type: "complete" }
        : {
            type: "incomplete",
            reason:
              "Dependent indexes await their replacement revision rebuild",
          };
    },
    repair: async (connection, tables) => {
      let progress = await readProgress(connection, checkpointName);
      if (progress === undefined) {
        const indexes = await readFunctionDependentIndexes(
          connection,
          functionSignature,
        );
        const batch = initialBatchState();
        await connection.execute(
          "INSERT INTO public.database_backfill_states (name, cursor, batch) VALUES ($1, NULL, $2::text::jsonb) ON CONFLICT (name) DO NOTHING",
          [
            checkpointName,
            JSON.stringify({
              ...batch,
              reindex: { indexes, status: "pending" },
            }),
          ],
        );
        progress = await readProgress(connection, checkpointName);
        if (progress === undefined) {
          return panic("Function-index reindex checkpoint was not stored");
        }
      }
      if (progress.status === "complete") {
        return { type: "complete" };
      }
      let pending = progress.cursor === null;
      for (const index of progress.indexes) {
        if (!pending) {
          pending = index.name === progress.cursor;
          continue;
        }
        const outcome = await tables.run({
          target: index,
          kind: "index_repair",
          work: async (session) => {
            await session.run(reindexIndexConcurrently(index));
          },
        });
        if (outcome.type === "deferred") {
          return outcome;
        }
        await connection.execute(
          "UPDATE public.database_backfill_states SET cursor = $2, updated_at = now() WHERE name = $1",
          [checkpointName, index.name],
        );
      }
      await connection.execute(
        "UPDATE public.database_backfill_states SET batch = jsonb_set(batch, '{reindex,status}', '\"complete\"'::jsonb), updated_at = now() WHERE name = $1",
        [checkpointName],
      );
      return { type: "complete" };
    },
  } satisfies OnlineRepair & { functionSignature: string };
};

/** Each replacement revision registers once; the repair discovers its index workset. */
export const FUNCTION_DEPENDENT_INDEX_REINDEXES: readonly ReturnType<
  typeof createFunctionDependentIndexReindex
>[] = [
  createFunctionDependentIndexReindex({
    functionSignature: CASE_LAW_FILING_YEAR_FUNCTION_SIGNATURE,
    replacementRevision: "20261030111452_decision_docket_filing_year_workplace",
  }),
];
