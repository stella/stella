import { panic, Result, TaggedError } from "better-result";

import { runBackfillPass } from "@stll/db-load-gate/backfill-pass";
import { defaultConfig, type Verdict } from "@stll/db-load-gate/health";

import { queryOrganizationFencedRepairBatch } from "../lib/db/aggregate-lock";
import { isRecord } from "../lib/type-guards";
import { createBackfillRuntime } from "./backfill-runtime";
import {
  convertLegacyChatContent,
  LegacyChatContentError,
  LOSSY_JSON_NUMBER,
} from "./chat-content-v3-legacy";
import { readConstraintCompletion } from "./online-constraint-completion";
import { validateOnlineConstraints } from "./online-ddl";
import type { OnlineConstraintValidation } from "./online-ddl";
import type {
  OnlineMigrationConnection,
  OnlineRepair,
} from "./online-migration-connection";
import { CHAT_CONTENT_V3_BACKFILL_OUTCOMES } from "./schema/chat";
import type { chatContentV3BackfillReceipts } from "./schema/chat";

// Bound JSON conversion and row locks even for tool-heavy conversations.
const CHAT_CONTENT_V3_BATCH_SIZE = 50;
const PG_INTEGER_MIN = -(2 ** 31);
const PG_INTEGER_MAX = 2 ** 31 - 1;
type ChatContentV3Source =
  typeof chatContentV3BackfillReceipts.$inferInsert.source;
export const CHAT_CONTENT_V3_SOURCES = {
  message: { table: "chat_messages", messageId: "id" },
  revision: { table: "chat_message_revisions", messageId: "message_id" },
} as const satisfies Record<
  ChatContentV3Source,
  { table: string; messageId: string }
>;
const chatContentV3Source = (key: string): ChatContentV3Source => {
  if (key === "message" || key === "revision") {
    return key;
  }
  return panic("Unknown chat backfill source");
};
const backfillName = (source: ChatContentV3Source) =>
  `chat-content-v3-${source}`;

class ChatContentV3UpgradeError extends TaggedError(
  "ChatContentV3UpgradeError",
)<{
  message: string;
  cause?: unknown;
}> {}

type ChatContentV3Receipt = {
  row_id: string;
  message_id: string;
  organization_id: string;
  from_version: number | null;
  outcome: typeof chatContentV3BackfillReceipts.$inferInsert.outcome;
  reason: string;
};

type BatchOptions = {
  tx: Pick<OnlineMigrationConnection, "query" | "execute">;
  source: ChatContentV3Source;
  cursor: string | null;
  size: number;
};
export const backfillChatContentV3Batch = async ({
  tx,
  source,
  cursor,
  size,
}: BatchOptions) => {
  const { table, messageId } = CHAT_CONTENT_V3_SOURCES[source];
  const rows = await queryOrganizationFencedRepairBatch({
    connection: tx,
    // Fence organization deletion until its receipts commit; message deletion
    // remains free to proceed and is recorded by the receipt join.
    query: `SELECT target.id, target.${messageId} AS message_id, target.content,
       md5(target.content::text) AS content_hash, thread.organization_id
     FROM ${table} AS target
     ${source === "revision" ? "JOIN chat_messages AS message ON message.id = target.message_id" : ""}
     JOIN chat_threads AS thread ON thread.id = ${source === "revision" ? "message" : "target"}.thread_id
     JOIN organization AS tenant ON tenant.id = thread.organization_id
     ${cursor === null ? "ORDER BY target.id LIMIT $1" : "WHERE target.id > $1::uuid ORDER BY target.id LIMIT $2"}`,
    params:
      cursor === null
        ? [Math.min(size, CHAT_CONTENT_V3_BATCH_SIZE)]
        : [cursor, Math.min(size, CHAT_CONTENT_V3_BATCH_SIZE)],
  });
  const receipts: ChatContentV3Receipt[] = [];
  const updates = [];
  let last = cursor;
  for (const row of rows) {
    if (
      !isRecord(row) ||
      typeof row["id"] !== "string" ||
      typeof row["message_id"] !== "string" ||
      typeof row["content_hash"] !== "string" ||
      typeof row["organization_id"] !== "string"
    ) {
      return panic("Invalid chat backfill row identity");
    }
    last = row["id"];
    const content = row["content"];
    const rawVersion = isRecord(content) ? content["version"] : null;
    const version =
      typeof rawVersion === "number" &&
      Number.isInteger(rawVersion) &&
      rawVersion >= PG_INTEGER_MIN &&
      rawVersion <= PG_INTEGER_MAX
        ? rawVersion
        : null;
    if (version === 3) {
      receipts.push({
        row_id: last,
        message_id: row["message_id"],
        organization_id: row["organization_id"],
        from_version: version,
        outcome: "skipped",
        reason: "already-v3",
      });
      continue;
    }
    const converted = Result.try({
      try: () => convertLegacyChatContent(content),
      catch: (error) =>
        error instanceof LegacyChatContentError
          ? error.reason
          : "invalid-legacy-content",
    });
    if (converted.isErr()) {
      receipts.push({
        row_id: last,
        message_id: row["message_id"],
        organization_id: row["organization_id"],
        from_version: version,
        outcome: "failed",
        reason: converted.error,
      });
      continue;
    }
    updates.push({
      id: last,
      content: converted.value,
      previous_content: content,
      previous_hash: row["content_hash"],
    });
    receipts.push({
      row_id: last,
      message_id: row["message_id"],
      organization_id: row["organization_id"],
      from_version: version,
      outcome: "converted",
      reason: "normalized-and-proved-v3",
    });
  }
  if (updates.length > 0) {
    // The hash proves the row is unchanged since the read; jsonb equality with
    // the parsed copy proves the JavaScript round trip kept every number exact.
    const written = await tx.query(
      `WITH patch AS (
         SELECT * FROM jsonb_to_recordset($1::text::jsonb)
         AS patch(id uuid, content jsonb, previous_content jsonb, previous_hash text)
       ), updated AS (
         UPDATE ${table} AS target SET content = patch.content
         FROM patch
         WHERE target.id = patch.id
           AND md5(target.content::text) = patch.previous_hash
           AND target.content = patch.previous_content
         RETURNING target.id
       )
       SELECT patch.id,
         CASE
           WHEN updated.id IS NOT NULL THEN 'updated'
           WHEN md5(target.content::text) = patch.previous_hash THEN 'lossy'
           ELSE 'changed'
         END AS result
       FROM patch
       LEFT JOIN updated ON updated.id = patch.id
       LEFT JOIN ${table} AS target ON target.id = patch.id`,
      [JSON.stringify(updates)],
    );
    const results = new Map(
      written.map((row) => {
        if (
          !isRecord(row) ||
          typeof row["id"] !== "string" ||
          (row["result"] !== "updated" &&
            row["result"] !== "lossy" &&
            row["result"] !== "changed")
        ) {
          return panic("Invalid chat backfill update result");
        }
        return [row["id"], row["result"]] as const;
      }),
    );
    for (const receipt of receipts) {
      if (receipt.outcome !== "converted") {
        continue;
      }
      const result =
        results.get(receipt.row_id) ??
        panic("Chat backfill update result missing for a converted row");
      switch (result) {
        case "updated":
          break;
        case "lossy":
          // Writing would round a number the driver parsed as a double.
          receipt.outcome = "failed";
          receipt.reason = LOSSY_JSON_NUMBER;
          break;
        case "changed":
          // Preserve a concurrent writer's content instead of replacing a newer value.
          receipt.outcome = "skipped";
          receipt.reason = "concurrent-change";
          break;
        default:
          result satisfies never;
          panic("Unhandled chat backfill update result");
      }
    }
  }
  if (receipts.length > 0) {
    // Receipts outlive deletion and contain only identifiers and fixed reasons.
    // The live-parent join records deletions without racing a foreign-key check;
    // a replay still retains the original conversion provenance.
    const recorded = await tx.query(
      `INSERT INTO chat_content_v3_backfill_receipts
       (source, row_id, message_id, organization_id, from_version, outcome, reason)
       SELECT $1, receipt.row_id, receipt.message_id, receipt.organization_id, receipt.from_version,
         CASE WHEN parent.id IS NULL THEN 'deleted-concurrently' ELSE receipt.outcome END,
         CASE WHEN parent.id IS NULL THEN 'parent-deleted' ELSE receipt.reason END
       FROM jsonb_to_recordset($2::text::jsonb)
       AS receipt(row_id uuid, message_id uuid, organization_id text, from_version integer, outcome text, reason text)
       LEFT JOIN chat_messages AS parent ON parent.id = receipt.message_id
       WHERE true
       ON CONFLICT (source, row_id) DO UPDATE SET
       from_version = EXCLUDED.from_version, outcome = EXCLUDED.outcome,
       reason = EXCLUDED.reason, recorded_at = now()
       WHERE chat_content_v3_backfill_receipts.outcome <> 'converted'
       RETURNING row_id, outcome, reason`,
      [source, JSON.stringify(receipts)],
    );
    const receiptsById = new Map(
      receipts.map((receipt) => [receipt.row_id, receipt]),
    );
    for (const row of recorded) {
      if (
        !isRecord(row) ||
        typeof row["row_id"] !== "string" ||
        typeof row["reason"] !== "string"
      ) {
        panic("Invalid chat backfill receipt identity");
      }
      const outcome = CHAT_CONTENT_V3_BACKFILL_OUTCOMES.find(
        (candidate) => candidate === row["outcome"],
      );
      const receipt = receiptsById.get(row["row_id"]);
      if (outcome === undefined || receipt === undefined) {
        panic("Invalid chat backfill receipt outcome");
      }
      receipt.outcome = outcome;
      receipt.reason = row["reason"];
    }
  }
  return { cursor: last, done: rows.length === 0, value: receipts };
};

export const readChatContentV3Completion: OnlineRepair["readCompletion"] =
  async (connection) => {
    for (const { table } of Object.values(CHAT_CONTENT_V3_SOURCES)) {
      const constraint = await readConstraintCompletion({
        connection,
        constraintName: `${table}_content_v3_check`,
        tableName: table,
        repairName: "chat-content-v3",
      });
      if (constraint.type === "complete") {
        continue;
      }
      const rows = await connection.query(
        `SELECT id FROM ${table} WHERE (content -> 'version') IS DISTINCT FROM '3'::jsonb LIMIT 1`,
      );
      if (rows.length > 0) {
        return {
          type: "incomplete",
          reason:
            "Non-v3 chat content remains; inspect chat_content_v3_backfill_receipts, repair failed rows and retry",
        };
      }
      return constraint;
    }
    return { type: "complete" };
  };

/** The write guards a schema migration added NOT VALID, one per source. */
export const CHAT_CONTENT_V3_CONSTRAINTS = Object.values(
  CHAT_CONTENT_V3_SOURCES,
).map(({ table }) => ({
  tableName: table,
  constraintName: `${table}_content_v3_check`,
})) satisfies readonly OnlineConstraintValidation[];

type RepairOptions = {
  readVerdict?: () => Promise<Verdict>;
  sleep?: (milliseconds: number) => Promise<void>;
  log?: (record: unknown) => void;
};
export const createChatContentV3Repair = (options: RepairOptions = {}) =>
  ({
    name: "chat-content-v3",
    readCompletion: readChatContentV3Completion,
    repair: async (connection, tables) => {
      for (const key of Object.keys(CHAT_CONTENT_V3_SOURCES)) {
        const source = chatContentV3Source(key);
        // Fresh installations have no data work or metric source to wait for.
        if (
          (
            await connection.query(
              `SELECT id FROM ${CHAT_CONTENT_V3_SOURCES[source].table} LIMIT 1`,
            )
          ).length === 0
        ) {
          continue;
        }
        const runtime = createBackfillRuntime({
          connection,
          name: backfillName(source),
          tableName: CHAT_CONTENT_V3_SOURCES[source].table,
          initialSize: CHAT_CONTENT_V3_BATCH_SIZE,
          config: {
            ...defaultConfig,
            minSize: 1,
            maxSize: CHAT_CONTENT_V3_BATCH_SIZE,
          },
          readVerdict: options.readVerdict,
          ...(tables.isPaused === undefined
            ? {}
            : { isPaused: tables.isPaused }),
          log: options.log,
        });
        try {
          const pass = await runBackfillPass({
            holdPolicy: "propagate",
            sleep: options.sleep ?? Bun.sleep,
            step: async () =>
              await runtime.step(
                async ({ tx, size, cursor }) =>
                  await backfillChatContentV3Batch({
                    tx,
                    size,
                    cursor,
                    source,
                  }),
              ),
          });
          if (pass.isErr()) {
            // v3-only readers cannot start with a pending legacy checkpoint.
            throw new ChatContentV3UpgradeError({
              message:
                "Chat content v3 upgrade deferred; rerun db:migrate to resume",
              cause: pass.error,
            });
          }
        } finally {
          await runtime.close();
        }
      }
      for (const { table } of Object.values(CHAT_CONTENT_V3_SOURCES)) {
        const rows = await connection.query(
          `SELECT id FROM ${table} WHERE (content -> 'version') IS DISTINCT FROM '3'::jsonb LIMIT 1`,
        );
        if (rows.length > 0) {
          throw new ChatContentV3UpgradeError({
            message:
              "Non-v3 chat content remains; inspect chat_content_v3_backfill_receipts, repair failed rows and retry",
          });
        }
      }
      // Validation proves existing rows; NOT VALID already fenced new writes.
      // The gated scan runs with no statement budget: its SHARE UPDATE
      // EXCLUSIVE lock blocks neither reads nor writes.
      const validated = await Result.tryPromise(
        async () =>
          await validateOnlineConstraints({
            connection,
            tables,
            constraints: CHAT_CONTENT_V3_CONSTRAINTS,
          }),
      );
      if (validated.isErr()) {
        throw new ChatContentV3UpgradeError({
          message: "Chat v3 constraint validation failed; rerun db:migrate",
          cause: validated.error,
        });
      }
      return validated.value;
    },
  }) as const satisfies OnlineRepair;
export const CHAT_CONTENT_V3_REPAIR = createChatContentV3Repair();

export const countChatContentVersions = async (
  connection: Pick<OnlineMigrationConnection, "query">,
) => {
  const counts = [];
  for (const [source, { table }] of Object.entries(CHAT_CONTENT_V3_SOURCES)) {
    const versions = await connection.query(
      `SELECT content ->> 'version' AS version, count(*)::text AS count FROM ${table} GROUP BY content ->> 'version'`,
    );
    counts.push({ source, versions });
  }
  return counts;
};

// Repaired poison rows can precede the cursor. Rewalk; retain conversion receipts.
export const resetChatContentV3Checkpoints = async (
  connection: Pick<OnlineMigrationConnection, "execute">,
) => {
  await connection.execute(
    "DELETE FROM database_backfill_states WHERE name IN ($1, $2)",
    [backfillName("message"), backfillName("revision")],
  );
};
