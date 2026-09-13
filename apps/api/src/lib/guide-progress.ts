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
