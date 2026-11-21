import { asc, desc, sql } from "drizzle-orm";

import { chatTurns } from "@/api/db/schema";

declare const query: { orderBy: (...columns: unknown[]) => unknown };
declare const turnId: string;

// A turn's start as a sort key.
// oxlint-disable-next-line no-chat-turn-time-order/no-chat-turn-time-order
const _newest = query.orderBy(desc(chatTurns.createdAt), desc(chatTurns.id));
// oxlint-disable-next-line no-chat-turn-time-order/no-chat-turn-time-order
const _oldest = asc(chatTurns.createdAt);
// oxlint-disable-next-line no-chat-turn-time-order/no-chat-turn-time-order
const _bare = query.orderBy(chatTurns.createdAt);

// A turn's start compared, alone or as the head of a row value.
// oxlint-disable-next-line no-chat-turn-time-order/no-chat-turn-time-order
const _later = sql`(${chatTurns.createdAt}, ${chatTurns.id}) > (select t.created_at, t.id from chat_turns t where t.id = ${turnId})`;
// oxlint-disable-next-line no-chat-turn-time-order/no-chat-turn-time-order
const _since = sql`${chatTurns.createdAt} >= now() - interval '1 day'`;
// oxlint-disable-next-line no-chat-turn-time-order/no-chat-turn-time-order
const _sorted = sql`ORDER BY ${chatTurns.createdAt}`;
// oxlint-disable-next-line no-chat-turn-time-order/no-chat-turn-time-order
const _descending = sql`${chatTurns.createdAt} DESC`;

// The start read as a time, and other columns as sort keys, are fine.
// expect-clean: no-chat-turn-time-order/no-chat-turn-time-order
const _lease = sql`${chatTurns.createdAt} + interval '1 millisecond'`;
// expect-clean: no-chat-turn-time-order/no-chat-turn-time-order
const _shown = sql<Date>`coalesce(${chatTurns.activeStartedAt}, ${chatTurns.createdAt})`;
// expect-clean: no-chat-turn-time-order/no-chat-turn-time-order
const _byId = query.orderBy(desc(chatTurns.id));

export const __noChatTurnTimeOrderFixture = {
  _newest,
  _oldest,
  _bare,
  _later,
  _since,
  _sorted,
  _descending,
  _lease,
  _shown,
  _byId,
};
