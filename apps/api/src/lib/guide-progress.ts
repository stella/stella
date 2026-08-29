import { sql } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import type { SafeId } from "@/api/lib/branded-types";

export const GUIDE_PROGRESS_TOUR_IDS = [
  "chat",
  "documents",
  "playbooks",
  "workflows",
  "tabular-review",
] as const;

export const GUIDE_PROGRESS_STATUSES = [
  "not-started",
  "completed",
  "skipped",
] as const;

type GuideProgressTourId = (typeof GUIDE_PROGRESS_TOUR_IDS)[number];
type GuideProgressStatus = (typeof GUIDE_PROGRESS_STATUSES)[number];

type UpdatedGuideProgressRow = {
  guideProgress: string;
};

export const patchUserGuideProgress = async ({
  db,
  status,
  tourId,
  userId,
}: {
  db?: Pick<typeof rootDb, "execute">;
  status: GuideProgressStatus;
  tourId: GuideProgressTourId;
  userId: SafeId<"user">;
}): Promise<string | null> => {
  const rows = await (db ?? rootDb).execute<UpdatedGuideProgressRow>(sql`
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
