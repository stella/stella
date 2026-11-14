import { asc, desc, sql } from "drizzle-orm";

import { chatTurns } from "@/api/db/schema";

/**
 * The order of a thread's turns, the one place that states it.
 *
 * A turn's `ordinal` is its position by acceptance, assigned by the database
 * under the thread's lock, so a later turn always has the larger one. A
 * turn's start time does not order turns: it is its transaction's start, and
 * a transaction that started first can take the thread's lock second.
 *
 * Compatibility, until the pending contract step
 * `20261114200100_chat_turn_ordinals_contract` ships: a turn stored before
 * the column has no ordinal until the `chat-turn-ordinals` repair numbers
 * it. Such turns are older than every numbered one, so they sort after them
 * here, among themselves in the stored order the repair numbers them in.
 * The contract step makes the column NOT NULL, and the two trailing terms of
 * each order go with it.
 */
export const NEWEST_CHAT_TURN_FIRST = [
  sql`${chatTurns.ordinal} DESC NULLS LAST`,
  desc(chatTurns.createdAt),
  desc(chatTurns.id),
] as const;

/** A thread's turns in the order they were accepted. */
export const OLDEST_CHAT_TURN_FIRST = [
  sql`${chatTurns.ordinal} ASC NULLS FIRST`,
  asc(chatTurns.createdAt),
  asc(chatTurns.id),
] as const;
