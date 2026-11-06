import { chatRunsChangedRealtimeEvent } from "@stll/api-contract";

import type { SafeId } from "@/api/lib/branded-types";
import { broadcastToUser } from "@/api/lib/sse";

/** The member whose active chat runs a turn status write changed. */
export type ChatRunOwner = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};

const CHAT_RUN_PINGS = Symbol("ChatRunPings");

/**
 * The owners whose turn status a transaction changed. Every function that
 * writes `chat_turns.status` takes one and records the turn's owner on it, so
 * a status write that tells nobody does not type-check. Only
 * `withChatRunPings` makes one: the brand is a module-private symbol, so no
 * other code can produce a value of this type.
 */
export type ChatRunPings = {
  readonly [CHAT_RUN_PINGS]: true;
  /** Record that `owner`'s active runs changed in the open transaction. */
  readonly changed: (owner: ChatRunOwner) => void;
};

const ownerKey = ({ organizationId, userId }: ChatRunOwner): string =>
  JSON.stringify([organizationId, userId]);

/**
 * Collect the owners whose turns `run` changed and ping each one, once, when
 * `run` settles. Wrap the call that opens and commits the transaction (a
 * `safeDb(...)` or `db.transaction(...)`), never a call inside one: the ping
 * tells a client to re-read, and a re-read before the commit sees the old
 * state. The ping goes out whether the transaction committed or rolled back:
 * the event carries nothing, so a ping for a write that did not land costs one
 * re-read, while a missing ping leaves a client showing a run that ended.
 */
export const withChatRunPings = async <T>(
  run: (pings: ChatRunPings) => Promise<T>,
): Promise<T> => {
  const owners = new Map<string, ChatRunOwner>();
  const pings: ChatRunPings = {
    [CHAT_RUN_PINGS]: true,
    changed: (owner) => {
      owners.set(ownerKey(owner), owner);
    },
  };
  try {
    return await run(pings);
  } finally {
    for (const { organizationId, userId } of owners.values()) {
      broadcastToUser(userId, organizationId, chatRunsChangedRealtimeEvent());
    }
  }
};
