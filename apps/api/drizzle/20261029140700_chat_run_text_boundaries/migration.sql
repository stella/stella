SET lock_timeout = '3s';
SET statement_timeout = '30s';

ALTER TABLE "chat_run_log_entries" ADD COLUMN "text_message_end_seq" bigint;
ALTER TABLE "chat_run_log_entries" ADD COLUMN "text_boundary_initialization" text;
ALTER TABLE "chat_run_log_entries" ADD CONSTRAINT "chat_run_log_entries_text_end_check" CHECK ((text_boundary_initialization IS NULL AND text_message_end_seq IS NULL) OR (text_boundary_initialization IS NOT NULL AND text_boundary_initialization = 'recorded' AND (text_message_end_seq IS NULL OR text_message_end_seq > seq))) NOT VALID;

CREATE FUNCTION public.stella_chat_run_text_boundaries() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $function$
BEGIN
  -- Initialize only the inserted role boundaries, never retained rows.
  UPDATE public.chat_run_log_entries AS target SET text_message_end_seq = NULL, text_boundary_initialization = 'recorded'
  FROM inserted_run_entries AS incoming
  WHERE target.organization_id = incoming.organization_id
    AND target.run_id = incoming.run_id AND target.seq = incoming.seq
    AND (incoming.chunk->>'type' = 'TEXT_MESSAGE_START'
      OR (incoming.chunk->>'type' = 'TEXT_MESSAGE_CHUNK' AND incoming.chunk ? 'role'));

  -- Closing metadata is derived from the original events in this same insert.
  UPDATE public.chat_run_log_entries AS target SET text_message_end_seq = closed.end_seq, text_boundary_initialization = 'recorded'
  FROM (
    SELECT started.organization_id, started.run_id, started.seq, min(incoming.seq) AS end_seq
    FROM public.chat_run_log_entries AS started
    JOIN inserted_run_entries AS incoming
      ON incoming.organization_id = started.organization_id
      AND incoming.run_id = started.run_id AND incoming.seq > started.seq
    WHERE started.text_message_end_seq IS NULL
      AND (started.chunk->>'type' = 'TEXT_MESSAGE_START'
        OR (started.chunk->>'type' = 'TEXT_MESSAGE_CHUNK' AND started.chunk ? 'role'))
      AND (
        (incoming.chunk->>'type' = 'TEXT_MESSAGE_END' AND (
          incoming.chunk->>'messageId' = started.chunk->>'messageId'
          OR started.chunk->>'messageId' IS NULL
          OR (incoming.chunk->>'messageId' IS NULL AND started.seq = (
            SELECT boundary.seq FROM public.chat_run_log_entries AS boundary
            WHERE boundary.organization_id = incoming.organization_id
              AND boundary.run_id = incoming.run_id AND boundary.seq < incoming.seq
              AND (boundary.chunk->>'type' = 'TEXT_MESSAGE_START'
                OR (boundary.chunk->>'type' = 'TEXT_MESSAGE_CHUNK' AND boundary.chunk ? 'role'))
            ORDER BY boundary.seq DESC LIMIT 1
          ))
        ))
        OR ((incoming.chunk->>'type' = 'TEXT_MESSAGE_START'
          OR (incoming.chunk->>'type' = 'TEXT_MESSAGE_CHUNK' AND incoming.chunk ? 'role'))
          AND (incoming.chunk->>'messageId' = started.chunk->>'messageId'
            OR started.chunk->>'messageId' IS NULL))
      )
    GROUP BY started.organization_id, started.run_id, started.seq
  ) AS closed
  WHERE target.organization_id = closed.organization_id
    AND target.run_id = closed.run_id AND target.seq = closed.seq;
  RETURN NULL;
END
$function$;

CREATE TRIGGER chat_run_log_entries_text_boundaries
AFTER INSERT ON public.chat_run_log_entries
REFERENCING NEW TABLE AS inserted_run_entries
FOR EACH STATEMENT EXECUTE FUNCTION public.stella_chat_run_text_boundaries();

REVOKE ALL ON FUNCTION public.stella_chat_run_text_boundaries() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.stella_chat_run_text_boundaries() TO stella;
