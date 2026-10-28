import type { OnlineRepair } from "./online-migration-connection";

const PENDING_TEXT_BOUNDARIES = `FROM public.chat_run_log_entries
WHERE text_message_end_seq = -1 AND (chunk->>'type' = 'TEXT_MESSAGE_START'
OR (chunk->>'type' = 'TEXT_MESSAGE_CHUNK' AND chunk ? 'role'))`;

/** Retained starts leave the sentinel predicate in committed, restartable batches. */
export const CHAT_RUN_TEXT_BOUNDARIES = {
  name: "chat-run-text-boundaries",
  readCompletion: async (connection) => {
    const pending = await connection.query(
      `SELECT 1 ${PENDING_TEXT_BOUNDARIES} LIMIT 1`,
      [],
    );
    return pending.length === 0
      ? { type: "complete" }
      : { type: "incomplete", reason: "Run text boundaries are pending" };
  },
  repair: async (connection) => {
    await connection.execute("SET statement_timeout = '30s'");
    try {
      for (;;) {
        const rows = await connection.query(
          `WITH batch AS (
        SELECT organization_id, run_id, seq, chunk ${PENDING_TEXT_BOUNDARIES}
        ORDER BY organization_id, run_id, seq LIMIT 500
      ) UPDATE public.chat_run_log_entries target SET text_message_end_seq = (
        SELECT boundary.seq FROM public.chat_run_log_entries boundary
        WHERE boundary.organization_id = batch.organization_id AND boundary.run_id = batch.run_id
          AND boundary.seq > batch.seq
          AND (batch.chunk->>'messageId' IS NULL OR (
            md5(boundary.chunk->>'messageId') = md5(batch.chunk->>'messageId')
            AND boundary.chunk->>'messageId' = batch.chunk->>'messageId'))
          AND (boundary.chunk->>'type' = 'TEXT_MESSAGE_START'
            OR (boundary.chunk->>'type' = 'TEXT_MESSAGE_CHUNK' AND boundary.chunk ? 'role')
            OR boundary.chunk->>'type' = 'TEXT_MESSAGE_END')
        ORDER BY boundary.seq LIMIT 1
      ) FROM batch WHERE target.organization_id = batch.organization_id
        AND target.run_id = batch.run_id AND target.seq = batch.seq AND target.text_message_end_seq = -1
      RETURNING target.seq`,
          [],
        );
        if (rows.length === 0) {
          return { type: "complete" } as const;
        }
      }
    } finally {
      await connection.execute("SET statement_timeout = 0");
    }
  },
} satisfies OnlineRepair;
