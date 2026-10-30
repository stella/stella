import { and, eq, like } from "drizzle-orm";

import { session } from "@/api/db/auth-schema";
import type { RootDatabase } from "@/api/db/root";
import { syntheticSessionControl } from "@/api/db/schema";
import { liveSessionPredicate } from "@/api/lib/auth/session-liveness";
import { escapeLike } from "@/api/lib/escape-like";

import {
  isSyntheticPrincipal,
  SYNTHETIC_PRINCIPAL,
  SYNTHETIC_SESSION_CONTROL_ID,
  SYNTHETIC_SESSION_PREFIX,
} from "./constants";

type ReadSyntheticSessionAuthorityOptions = {
  sessionId: string | null;
  userId: string;
  now?: Date;
};

export type SyntheticSessionAuthorityReader = (
  options: ReadSyntheticSessionAuthorityOptions,
) => Promise<{ expiresAt: Date; sessionId: string } | null>;

export const readSyntheticSessionAuthority = async (
  db: Pick<RootDatabase, "select">,
  { sessionId, userId, now = new Date() }: ReadSyntheticSessionAuthorityOptions,
) => {
  if (sessionId === null) {
    return null;
  }
  const [row] = await db
    .select({ sessionId: session.id, expiresAt: session.expiresAt })
    .from(session)
    .innerJoin(
      syntheticSessionControl,
      and(
        eq(syntheticSessionControl.id, SYNTHETIC_SESSION_CONTROL_ID),
        eq(syntheticSessionControl.status, "enabled"),
      ),
    )
    .where(
      and(
        eq(session.id, sessionId),
        eq(session.userId, userId),
        eq(session.userId, SYNTHETIC_PRINCIPAL.user.id),
        eq(session.activeOrganizationId, SYNTHETIC_PRINCIPAL.org.id),
        eq(session.refreshMode, "fixed"),
        like(session.id, `${escapeLike(SYNTHETIC_SESSION_PREFIX)}%`),
        liveSessionPredicate(now),
      ),
    )
    .limit(1);
  return row ?? null;
};

export const authorizeSyntheticSession = async (
  db: Pick<RootDatabase, "select">,
  current: { id: string; userId: string },
) =>
  !isSyntheticPrincipal({ userId: current.userId }) ||
  Boolean(
    await readSyntheticSessionAuthority(db, {
      sessionId: current.id,
      userId: current.userId,
    }),
  );
