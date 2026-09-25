import { sql } from "drizzle-orm";

import type {
  GuideProgressStatus,
  GuideProgressTourId,
} from "@stll/api-contract";

import { rootDb } from "@/api/db/root";
import type { SafeId } from "@/api/lib/branded-types";

type UpdatedGuideProgressRow = {
  guideProgress: string;
};

type GuideProgressUpdate = {
  status: GuideProgressStatus;
  tourId: GuideProgressTourId;
  userId: SafeId<"user">;
};

/**
 * Set one tour's status in the user's guide progress map, atomically, through
 * `db`. Returns the stored map, or null when the user row does not exist.
 */
export const writeUserGuideProgress = async (
  db: Pick<typeof rootDb, "execute">,
  { status, tourId, userId }: GuideProgressUpdate,
): Promise<string | null> => {
  const rows = await db.execute<UpdatedGuideProgressRow>(sql`
    UPDATE "user"
    SET
      guide_progress = jsonb_set(
        coalesce(guide_progress::jsonb, '{}'::jsonb),
        ARRAY[${tourId}::text],
        to_jsonb(${status}::text),
        true
      )::text,
      updated_at = now()
    WHERE id = ${userId}
    RETURNING guide_progress AS "guideProgress"
  `);

  return rows.at(0)?.guideProgress ?? null;
};

/**
 * {@link writeUserGuideProgress} for the session user's own request. The
 * request carries no organization, so there is no scope to run it in, and the
 * `user` row admits no update from a scoped role; it goes through the owner
 * connection, bound to the authenticated user's id.
 */
export const patchUserGuideProgress = async (
  update: GuideProgressUpdate,
): Promise<string | null> => await writeUserGuideProgress(rootDb, update);
