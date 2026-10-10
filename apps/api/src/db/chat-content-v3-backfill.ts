import { panic, Result, TaggedError } from "better-result";

import { runBackfillPass } from "@stll/db-load-gate/backfill-pass";
import { defaultConfig, type Verdict } from "@stll/db-load-gate/health";

import { isRecord } from "../lib/type-guards";
import { createBackfillRuntime } from "./backfill-runtime";
import {
  convertLegacyChatContent,
  LegacyChatContentError,
} from "./chat-content-v3-legacy";
import { readConstraintCompletion } from "./online-constraint-completion";
import type {
  OnlineMigrationConnection,
  OnlineRepair,
} from "./online-migration-connection";
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
const backfillName = (source: ChatContentV3Source) =>
  `chat-content-v3-${source}`;

class ChatContentV3UpgradeError extends TaggedError(
  "ChatContentV3UpgradeError",
)<{
  message: string;
  cause?: unknown;
}> {}

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
  const rows = await tx.query(
    `SELECT id, ${messageId} AS message_id, content FROM ${table}
     ${cursor === null ? "ORDER BY id LIMIT $1" : "WHERE id > $1::uuid ORDER BY id LIMIT $2"}`,
    cursor === null
      ? [Math.min(size, CHAT_CONTENT_V3_BATCH_SIZE)]
      : [cursor, Math.min(size, CHAT_CONTENT_V3_BATCH_SIZE)],
  );
  const receipts = [];
  const updates = [];
  let last = cursor;
  for (const row of rows) {
    if (
      !isRecord(row) ||
      typeof row["id"] !== "string" ||
      typeof row["message_id"] !== "string"
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
    });
    receipts.push({
      row_id: last,
      message_id: row["message_id"],
      from_version: version,
      outcome: "converted",
      reason: "normalized-and-proved-v3",
    });
  }
  if (updates.length > 0) {
    const updated = await tx.query(
      `UPDATE ${table} AS target SET content = patch.content
       FROM jsonb_to_recordset($1::text::jsonb) AS patch(id uuid, content jsonb, previous_content jsonb)
       WHERE target.id = patch.id AND target.content = patch.previous_content
       RETURNING target.id`,
      [JSON.stringify(updates)],
    );
    const updatedIds = new Set(
      updated.map((row) => {
        if (!isRecord(row) || typeof row["id"] !== "string") {
          return panic("Invalid chat backfill update identity");
        }
        return row["id"];
      }),
    );
    // Preserve a concurrent writer's content instead of replacing a newer value.
    for (const receipt of receipts) {
      if (receipt.outcome === "converted" && !updatedIds.has(receipt.row_id)) {
        receipt.outcome = "skipped";
        receipt.reason = "concurrent-change";
      }
    }
  }
  if (receipts.length > 0) {
    // A replay must retain the original conversion provenance.
    await tx.execute(
      `INSERT INTO chat_content_v3_backfill_receipts
       (source, row_id, message_id, from_version, outcome, reason)
       SELECT $1, row_id, message_id, from_version, outcome, reason
       FROM jsonb_to_recordset($2::text::jsonb)
       AS receipt(row_id uuid, message_id uuid, from_version integer, outcome text, reason text)
       ON CONFLICT (source, row_id) DO UPDATE SET
       from_version = EXCLUDED.from_version, outcome = EXCLUDED.outcome,
       reason = EXCLUDED.reason, recorded_at = now()
       WHERE chat_content_v3_backfill_receipts.outcome <> 'converted'`,
      [source, JSON.stringify(receipts)],
    );
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

type RepairOptions = {
  readVerdict?: () => Promise<Verdict>;
  sleep?: (milliseconds: number) => Promise<void>;
  log?: (record: unknown) => void;
};
export const createChatContentV3Repair = (
  options: RepairOptions = {},
): OnlineRepair => ({
  name: "chat-content-v3",
  readCompletion: readChatContentV3Completion,
  repair: async (connection) => {
    for (const source of Object.keys(CHAT_CONTENT_V3_SOURCES)) {
      if (source !== "message" && source !== "revision") {
        return panic("Unknown chat backfill source");
      }
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
        log: options.log,
      });
      try {
        const pass = await runBackfillPass({
          holdPolicy: "propagate",
          sleep: options.sleep ?? Bun.sleep,
          step: async () =>
            await runtime.step(
              async ({ tx, size, cursor }) =>
                await backfillChatContentV3Batch({ tx, size, cursor, source }),
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
      // Validation proves existing rows; NOT VALID already fenced new writes.
      await connection.execute("BEGIN");
      const validated = await Result.tryPromise(async () => {
        await connection.execute("SET LOCAL lock_timeout = '1s'");
        await connection.execute("SET LOCAL statement_timeout = '5min'");
        await connection.execute(
          `ALTER TABLE public.${table} VALIDATE CONSTRAINT ${table}_content_v3_check`,
        );
      });
      if (validated.isErr()) {
        await connection.execute("ROLLBACK");
        throw new ChatContentV3UpgradeError({
          message: "Chat v3 constraint validation failed; rerun db:migrate",
          cause: validated.error,
        });
      }
      await connection.execute("COMMIT");
    }
  },
});
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
