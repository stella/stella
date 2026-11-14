-- requires: 20261114200000_chat_turn_ordinals
SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Every chat turn has a position: the insert trigger of the expand step gives
-- one to each new turn, whichever release inserts it, and the
-- `chat-turn-ordinals` repair has numbered the turns stored before it. Ship
-- this once that repair reads complete in every environment, together with
-- the removal of the stored-order terms in apps/api/src/lib/chat/turn-order.ts
-- and the retirement of chat_turns_org_user_thread_created_idx, which only
-- those terms read. chat_threads.last_turn_ordinal stays nullable: a thread
-- that has stored no turn has given out no position.
ALTER TABLE "chat_turns" ALTER COLUMN "ordinal" SET NOT NULL;
