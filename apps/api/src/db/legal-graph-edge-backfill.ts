/**
 * Online repair behind migration 20261112112228_legal_graph_edges.
 *
 * Derives the graph's `cites` and `sourced-from` edges for every claim,
 * re-check and fact Spot written before the writers existed, through the
 * writers' own statements, so the backfill and the live writers cannot
 * disagree on what an edge is.
 *
 * Claims and review events are forced row-secure with no owner access, so
 * the walk does not read them as the owner. It reads, as the owner, only
 * which matters hold verification runs or Spots, and derives each matter's
 * edges as the application role pinned to that matter, the way the run
 * worker writes them: walls and feature gates apply as they do to any write.
 *
 * Resumable and bounded: rows are read and written in batches in id order,
 * one transaction per batch, and the checkpoint advances only past a matter
 * whose rows are all done. A row already holding its edges is skipped by the
 * anti-join, and a row a live writer covered meanwhile by the edge identity.
 *
 * Two passes. API tasks still serving the previous release during the
 * rollout write rows without edges, so after the first pass the repair stays
 * pending, and a later migrate run, once `GRAPH_EDGE_ROLLOUT_GRACE_MS` has
 * passed since the first pass, walks again before it reads complete.
 */

import { panic } from "better-result";
import { sql } from "drizzle-orm";
import type { SQL, SQLWrapper } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { LIST_ITEM_TYPE } from "@stll/api-contract/entity-options";
import { initialBatchState } from "@stll/db-load-gate/health";
import { Temporal } from "@stll/time";

import {
  SETTING_ORGANIZATION_ID,
  SETTING_USER_ID,
  SETTING_WORKSPACE_ACCESS_MODE,
  SETTING_WORKSPACE_IDS,
  WORKSPACE_ACCESS_MODE,
} from "@/api/db/rls";
import {
  entities,
  legalGraphEdges,
  legalListClaimReviewEvents,
  legalListClaims,
  legalListItemSources,
  legalListVerificationRuns,
  workspaces,
} from "@/api/db/schema";
import { LEGAL_LISTS_FEATURE_ID } from "@/api/lib/feature-access/registry";
import type { GraphEdgeProducerKind } from "@/api/lib/lists/graph/contract";
import {
  recheckCitesSql,
  runCitesSql,
} from "@/api/lib/lists/graph/edge-writer";
import { factSourcesSql } from "@/api/lib/lists/graph/fact-source-edges";
import type { ClaimReviewEventKind } from "@/api/lib/lists/verification/contract";
import { isRecord } from "@/api/lib/type-guards";

import { onlineMigrationParams } from "./online-migration-connection";
import type {
  MigrationOwnedOnlineRepair,
  OnlineMigrationConnection,
} from "./online-migration-connection";
import { APPLICATION_RLS_ROLE_NAME } from "./role-names";

/** Rows one statement reads or writes, so each batch stays short. */
const GRAPH_EDGE_BACKFILL_BATCH_SIZE = 500;
/** Matters one read of the walk names. */
const MATTERS_PER_READ = 100;

const REPAIR_NAME = "legal-graph-edges";
const PASSES = [1, 2] as const;
type Pass = (typeof PASSES)[number];

const DIALECT = new PgDialect();
const RUN = "run" satisfies GraphEdgeProducerKind;
const RECHECK = "recheck" satisfies GraphEdgeProducerKind;
const RECHECK_EVENT = "recheck" satisfies ClaimReviewEventKind;

const UUID_PATTERN =
  "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

/** Whether some ref of `refs` names a fact the row's workspace still holds:
 *  only those become edges, so only those can be pending. */
const citesALiveFact = ({
  refs,
  workspace,
}: {
  refs: SQL;
  workspace: SQL;
}) => sql`EXISTS (
    SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${refs}) = 'array' THEN ${refs} ELSE '[]'::jsonb END) ref
    JOIN ${entities} fact
      ON fact.workspace_id = ${workspace}
      AND fact.list_item_type = ${LIST_ITEM_TYPE.FACT}
      AND fact.id = CASE WHEN ref.value->>'factEntityId' ~* ${UUID_PATTERN}
        THEN (ref.value->>'factEntityId')::uuid END
  )`;

const idsAfter = (column: SQL, cursor: string | null) =>
  cursor === null ? sql`true` : sql`${column} > ${cursor}::uuid`;

const idList = (column: SQL, ids: readonly string[]) =>
  sql`${column} = ANY(string_to_array(${ids.join(",")}, ',')::uuid[])`;

type PendingArgs = {
  workspaceId: string;
  cursor: string | null;
  limit: number;
};
type WriteArgs = { workspaceId: string; ids: readonly string[] };

/**
 * One family of rows the graph derives edges from. A row is pending while it
 * could produce an edge and has none from its producer: every edge of one row
 * is written by one statement, so a row has all of its edges or none.
 */
type EdgeSource = {
  name: string;
  /** The matter's pending rows after `cursor`, in id order. */
  pending: (args: PendingArgs) => SQL;
  /** The writer's own statement, for the given rows. */
  write: (args: WriteArgs) => SQL;
};

const EDGE_SOURCES: readonly EdgeSource[] = [
  {
    name: "run grades",
    pending: ({ workspaceId, cursor, limit }) => sql`SELECT claim.id
      FROM ${legalListClaims} claim
      WHERE claim.workspace_id = ${workspaceId}
        AND ${idsAfter(sql`claim.id`, cursor)}
        AND claim.refs <> '[]'::jsonb
        AND ${citesALiveFact({ refs: sql`claim.refs`, workspace: sql`claim.workspace_id` })}
        AND NOT EXISTS (
          SELECT 1 FROM ${legalGraphEdges} edge
          WHERE edge.workspace_id = claim.workspace_id
            AND edge.from_claim_id = claim.id
            AND edge.producer_kind = ${RUN}
        )
      ORDER BY claim.id
      LIMIT ${limit}`,
    write: ({ workspaceId, ids }) =>
      runCitesSql(
        sql`claim.workspace_id = ${workspaceId} AND ${idList(sql`claim.id`, ids)}`,
      ),
  },
  {
    name: "re-check grades",
    pending: ({ workspaceId, cursor, limit }) => sql`SELECT event.id
      FROM ${legalListClaimReviewEvents} event
      WHERE event.workspace_id = ${workspaceId}
        AND ${idsAfter(sql`event.id`, cursor)}
        AND event.kind = ${RECHECK_EVENT}
        AND ${citesALiveFact({ refs: sql`event.payload->'grade'->'refs'`, workspace: sql`event.workspace_id` })}
        AND NOT EXISTS (
          SELECT 1 FROM ${legalGraphEdges} edge
          WHERE edge.workspace_id = event.workspace_id
            AND edge.from_claim_id = event.claim_id
            AND edge.producer_kind = ${RECHECK}
            AND edge.producer_id = event.id
        )
      ORDER BY event.id
      LIMIT ${limit}`,
    write: ({ workspaceId, ids }) =>
      recheckCitesSql(
        sql`event.workspace_id = ${workspaceId} AND ${idList(sql`event.id`, ids)}`,
      ),
  },
  {
    name: "fact sources",
    pending: ({ workspaceId, cursor, limit }) => sql`SELECT source.id
      FROM ${legalListItemSources} source
      JOIN ${entities} item
        ON item.id = source.item_entity_id
        AND item.workspace_id = source.workspace_id
        AND item.list_item_type = ${LIST_ITEM_TYPE.FACT}
      WHERE source.workspace_id = ${workspaceId}
        AND ${idsAfter(sql`source.id`, cursor)}
        AND NOT EXISTS (
          SELECT 1 FROM ${legalGraphEdges} edge
          WHERE edge.workspace_id = source.workspace_id
            AND edge.source_id = source.id
        )
      ORDER BY source.id
      LIMIT ${limit}`,
    // Rows written before the writers carry no record of their origin.
    write: ({ workspaceId, ids }) =>
      factSourcesSql(
        sql`source.workspace_id = ${workspaceId} AND ${idList(sql`source.id`, ids)}`,
        { type: "inferred" },
      ),
  },
];

const run = async (
  connection: OnlineMigrationConnection,
  statement: SQLWrapper,
): Promise<readonly unknown[]> => {
  const rendered = DIALECT.sqlToQuery(statement.getSQL());
  return await connection.query(
    rendered.sql,
    onlineMigrationParams(rendered.params),
  );
};

const textField = (row: unknown, field: string): string => {
  const value = isRecord(row) ? row[field] : undefined;
  return typeof value === "string"
    ? value
    : panic(`Online repair ${REPAIR_NAME}: a row has no ${field}`);
};

type Matter = { workspaceId: string; organizationId: string };

/** Matters holding anything an edge derives from, after `cursor`, read as
 *  the owner: runs and Spots both admit it. */
const mattersAfter = async (
  connection: OnlineMigrationConnection,
  cursor: string | null,
): Promise<Matter[]> =>
  (
    await run(
      connection,
      // sql-perf-allow: bounded by MATTERS_PER_READ matters in id order; each EXISTS probes a workspace-leading index of runs or Spots.
      sql`SELECT workspace.id AS workspace_id, workspace.organization_id
        FROM ${workspaces} workspace
        WHERE ${idsAfter(sql`workspace.id`, cursor)}
          AND (
            EXISTS (SELECT 1 FROM ${legalListVerificationRuns} verification_run
              WHERE verification_run.workspace_id = workspace.id)
            OR EXISTS (SELECT 1 FROM ${legalListItemSources} item_source
              WHERE item_source.workspace_id = workspace.id)
          )
        ORDER BY workspace.id
        LIMIT ${MATTERS_PER_READ}`,
    )
  ).map((row) => ({
    workspaceId: textField(row, "workspace_id"),
    organizationId: textField(row, "organization_id"),
  }));

type BatchArgs = {
  connection: OnlineMigrationConnection;
  matter: Matter;
  source: EdgeSource;
  cursor: string | null;
};

/**
 * One batch, in one transaction, as the application role pinned to the
 * matter: its pending ids after `cursor`, and their edges. Returns the last
 * id, or null when the family has nothing left there.
 */
const deriveBatch = async ({
  connection,
  matter,
  source,
  cursor,
}: BatchArgs): Promise<string | null> => {
  await connection.execute("BEGIN");
  try {
    // The application role pinned to one matter, as a service actor (no
    // member) with the list feature on: the settings a scoped transaction
    // installs. The migration entrypoint cannot load the request-path
    // scoping module, so they are set here from the same names.
    await run(
      connection,
      sql`SELECT
        set_config('role', ${APPLICATION_RLS_ROLE_NAME}, true),
        set_config(${SETTING_WORKSPACE_IDS}, ${`{${matter.workspaceId}}`}, true),
        set_config(${SETTING_WORKSPACE_ACCESS_MODE}, ${WORKSPACE_ACCESS_MODE.explicit}, true),
        set_config(${SETTING_ORGANIZATION_ID}, ${matter.organizationId}, true),
        set_config(${SETTING_USER_ID}, '', true),
        set_config('app.enabled_features', ${JSON.stringify([LEGAL_LISTS_FEATURE_ID])}, true)`,
    );
    const ids = (
      await run(
        connection,
        source.pending({
          workspaceId: matter.workspaceId,
          cursor,
          limit: GRAPH_EDGE_BACKFILL_BATCH_SIZE,
        }),
      )
    ).map((row) => textField(row, "id"));
    const last = ids.at(-1) ?? null;
    if (last !== null) {
      await run(
        connection,
        source.write({ workspaceId: matter.workspaceId, ids }),
      );
    }
    await connection.execute("COMMIT");
    return last;
  } catch (error) {
    await connection.execute("ROLLBACK");
    throw error;
  }
};

/**
 * Where the walk stands: a pass still walking matters (after the last one it
 * finished), or a pass that walked them all, and when.
 */
type Checkpoint =
  | { type: "walking"; pass: Pass; after: string }
  | { type: "walked"; pass: Pass; finishedAt: number };

/** `<pass>:<last finished matter>`, or `<pass>:done@<finished at>`. */
const cursorOf = (checkpoint: Checkpoint): string => {
  switch (checkpoint.type) {
    case "walking": {
      return `${String(checkpoint.pass)}:${checkpoint.after}`;
    }
    case "walked": {
      return `${String(checkpoint.pass)}:done@${new Date(checkpoint.finishedAt).toISOString()}`;
    }
    default: {
      checkpoint satisfies never;
      return panic(`Online repair ${REPAIR_NAME}: unknown checkpoint`);
    }
  }
};

const WALKED_PREFIX = "done@";

const parseCursor = (cursor: string): Checkpoint => {
  const separator = cursor.indexOf(":");
  const pass = cursor.slice(0, separator);
  const after = cursor.slice(separator + 1);
  const parsedPass = PASSES.find((value) => String(value) === pass);
  if (separator === -1 || parsedPass === undefined || after === "") {
    return panic(`Online repair ${REPAIR_NAME}: invalid checkpoint ${cursor}`);
  }
  if (!after.startsWith(WALKED_PREFIX)) {
    return { type: "walking", pass: parsedPass, after };
  }
  const finishedAt = new Date(after.slice(WALKED_PREFIX.length)).getTime();
  return Number.isNaN(finishedAt)
    ? panic(`Online repair ${REPAIR_NAME}: invalid checkpoint ${cursor}`)
    : { type: "walked", pass: parsedPass, finishedAt };
};

const readCheckpoint = async (
  connection: OnlineMigrationConnection,
): Promise<Checkpoint | null> => {
  const row = (
    await connection.query(
      "SELECT cursor FROM public.database_backfill_states WHERE name = $1",
      [REPAIR_NAME],
    )
  ).at(0);
  return row === undefined ? null : parseCursor(textField(row, "cursor"));
};

const writeCheckpoint = async (
  connection: OnlineMigrationConnection,
  checkpoint: Checkpoint,
): Promise<void> => {
  await connection.execute(
    `INSERT INTO public.database_backfill_states (name, cursor, batch)
      VALUES ($1, $2, $3::text::jsonb)
      ON CONFLICT (name) DO UPDATE SET cursor = excluded.cursor, updated_at = now()`,
    [REPAIR_NAME, cursorOf(checkpoint), JSON.stringify(initialBatchState())],
  );
};

type WalkArgs = {
  connection: OnlineMigrationConnection;
  pass: Pass;
  after: string | null;
  now: () => number;
};

/** Walk every matter from `after`, recording each one finished. */
const walk = async ({ connection, pass, after, now }: WalkArgs) => {
  let matterCursor = after;
  for (;;) {
    const matters = await mattersAfter(connection, matterCursor);
    for (const matter of matters) {
      for (const source of EDGE_SOURCES) {
        let rowCursor: string | null = null;
        do {
          rowCursor = await deriveBatch({
            connection,
            matter,
            source,
            cursor: rowCursor,
          });
        } while (rowCursor !== null);
      }
      // Checkpoint last: only once every row of the matter is done.
      await writeCheckpoint(connection, {
        type: "walking",
        pass,
        after: matter.workspaceId,
      });
      matterCursor = matter.workspaceId;
    }
    if (matters.length < MATTERS_PER_READ) {
      break;
    }
  }
  await writeCheckpoint(connection, {
    type: "walked",
    pass,
    finishedAt: now(),
  });
};

/**
 * How long after the first pass the second may start: longer than any
 * rollout, so tasks of the release before the writers have stopped. A
 * second migrate run within one rollout leaves the repair pending.
 */
export const GRAPH_EDGE_ROLLOUT_GRACE_MS = 6 * 60 * 60 * 1000;

export const createLegalGraphEdgeBackfill = ({
  now = () => Temporal.Now.instant().epochMilliseconds,
}: { now?: () => number } = {}) =>
  ({
    introducedBy: "20261112112228_legal_graph_edges",
    name: REPAIR_NAME,
    readCompletion: async (connection) => {
      const checkpoint = await readCheckpoint(connection);
      if (checkpoint === null) {
        // Never started. A database holding nothing to derive from owes
        // nothing yet; every migrate run checks again until it holds rows.
        return (await mattersAfter(connection, null)).length === 0
          ? { type: "complete" }
          : { type: "incomplete", reason: "Graph edges are not derived yet" };
      }
      if (checkpoint.type === "walked" && checkpoint.pass === 2) {
        return { type: "complete" };
      }
      return {
        type: "pending",
        reason:
          checkpoint.type === "walked"
            ? "Graph edges await the walk after the writers' rollout"
            : "Graph edges are still being derived",
        cursor: cursorOf(checkpoint),
        holdUntil: null,
        heldSince: null,
      };
    },
    repair: async (connection) => {
      const checkpoint = await readCheckpoint(connection);
      if (checkpoint === null) {
        await walk({ connection, pass: 1, after: null, now });
        return { type: "complete" };
      }
      switch (checkpoint.type) {
        case "walking": {
          await walk({
            connection,
            pass: checkpoint.pass,
            after: checkpoint.after,
            now,
          });
          return { type: "complete" };
        }
        case "walked": {
          if (
            checkpoint.pass === 1 &&
            now() - checkpoint.finishedAt >= GRAPH_EDGE_ROLLOUT_GRACE_MS
          ) {
            await walk({ connection, pass: 2, after: null, now });
          }
          return { type: "complete" };
        }
        default: {
          checkpoint satisfies never;
          return panic(`Online repair ${REPAIR_NAME}: unknown checkpoint`);
        }
      }
    },
  }) satisfies MigrationOwnedOnlineRepair;

export const LEGAL_GRAPH_EDGE_BACKFILL = createLegalGraphEdgeBackfill();
