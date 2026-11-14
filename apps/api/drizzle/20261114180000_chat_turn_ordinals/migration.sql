SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- A turn's position in its thread by acceptance, and the largest position the
-- thread has given out. "Newest turn" and turn order read the position, not
-- the turn's start time: that time is the inserting transaction's start, so a
-- transaction that started first and took the thread's lock second stores the
-- later turn with the earlier time.
--
-- Both columns are nullable without a default, so adding them rewrites no row.
-- Turns stored before this migration are numbered by the online repair
-- `chat-turn-ordinals`; the unique index (chat_turns_thread_ordinal_uidx) is
-- built concurrently by its online migration entry in
-- apps/api/src/db/online-migration-entries/.
ALTER TABLE "chat_threads" ADD COLUMN "last_turn_ordinal" integer;--> statement-breakpoint
ALTER TABLE "chat_turns" ADD COLUMN "ordinal" integer;--> statement-breakpoint

-- Every turn gets the next position of its thread as it is inserted, whoever
-- inserts it: this release, an API task of the previous one that is still
-- running, or a test fixture. The thread's row is locked first (every send
-- already holds that lock), and the counter is read by the locking statement
-- itself, so it is the value the previous holder committed.
--
-- A thread that has not given out a position yet starts above the turns it
-- already holds. Those are numbered later from 1 in their stored order, and
-- only ever get fewer (an edit deletes turns, nothing adds an unnumbered
-- one), so they stay below every position given out here and no turn is ever
-- renumbered. A position is never given out twice: the counter does not go
-- back when a turn is deleted.
--
-- A thread the inserting role cannot see gets no position; the turn's own
-- row policy and its thread reference refuse that row.
CREATE FUNCTION public.assign_chat_turn_ordinal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $ordinal$
DECLARE
  given integer;
BEGIN
  SELECT last_turn_ordinal INTO given
    FROM public.chat_threads
   WHERE id = NEW.thread_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF given IS NULL THEN
    SELECT count(*)::integer INTO given
      FROM public.chat_turns
     WHERE thread_id = NEW.thread_id;
  END IF;
  NEW.ordinal := given + 1;
  UPDATE public.chat_threads
     SET last_turn_ordinal = NEW.ordinal
   WHERE id = NEW.thread_id;
  RETURN NEW;
END
$ordinal$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.assign_chat_turn_ordinal() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER chat_turns_assign_ordinal
  BEFORE INSERT ON public.chat_turns
  FOR EACH ROW
  EXECUTE FUNCTION public.assign_chat_turn_ordinal();
