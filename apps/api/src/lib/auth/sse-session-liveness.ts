import { and, inArray } from "drizzle-orm";

import { session } from "@/api/db/auth-schema";
import type { RootDatabase } from "@/api/db/root";
import { liveSessionPredicate } from "@/api/lib/auth/session-liveness";
import type { SseSessionLivenessReader } from "@/api/lib/sse";

/**
 * The sessions behind open event streams that still hold: the row exists,
 * belongs to the user the stream was opened for, and has not expired. Read
 * from the session table itself, never the cookie cache, so a signed-out,
 * revoked or expired session reads as gone on the next sweep.
 */
export const readLiveSseSessions = async (
  db: Pick<RootDatabase, "select">,
  sessions: Parameters<SseSessionLivenessReader>[0],
  now: Date = new Date(),
): Promise<ReadonlySet<string>> => {
  if (sessions.length === 0) {
    return new Set();
  }
  const owners = new Map(
    sessions.map((stream) => [stream.sessionId, stream.userId]),
  );
  const rows = await db
    .select({ id: session.id, userId: session.userId })
    .from(session)
    .where(
      and(inArray(session.id, [...owners.keys()]), liveSessionPredicate(now)),
    );
  return new Set(
    rows.filter((row) => owners.get(row.id) === row.userId).map(({ id }) => id),
  );
};
