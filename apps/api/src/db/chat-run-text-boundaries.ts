import { withDedicatedStatementTimeout } from "./long-running-connection";
import type { OnlineRepair } from "./online-migration-connection";

const PENDING_TEXT_BOUNDARIES = `FROM public.chat_run_log_entries
WHERE text_boundary_initialization IS NULL AND (chunk->>'type' = 'TEXT_MESSAGE_START'
OR (chunk->>'type' = 'TEXT_MESSAGE_CHUNK' AND chunk ? 'role'))`;

/** Retained starts leave the uninitialized predicate in committed, restartable batches. */
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
  repair: async (connection) =>
    await withDedicatedStatementTimeout({
      query: async (statement, parameters) =>
        await connection.query(statement, parameters),
      statementTimeoutMs: 30_000,
      work: async () => {
        for (;;) {
          const rows = await connection.query(
            `WITH batch AS (
        SELECT organization_id, run_id, seq, chunk ${PENDING_TEXT_BOUNDARIES}
        ORDER BY organization_id, run_id, seq LIMIT 500
      ), resolved AS (
        SELECT batch.organization_id, batch.run_id, batch.seq, (
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
      ) AS end_seq FROM batch
      ) UPDATE public.chat_run_log_entries target
      SET text_message_end_seq = resolved.end_seq,
        text_boundary_initialization = 'recorded'
      FROM resolved WHERE target.organization_id = resolved.organization_id
        AND target.run_id = resolved.run_id AND target.seq = resolved.seq AND target.text_boundary_initialization IS NULL
      RETURNING target.seq`,
            [],
          );
          if (rows.length === 0) {
            return { type: "complete" } as const;
          }
        }
      },
    }),
} satisfies OnlineRepair;
