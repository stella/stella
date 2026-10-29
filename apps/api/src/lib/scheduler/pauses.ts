import { panic } from "better-result";
import { sql } from "drizzle-orm";

import type { MaintenanceDb } from "@/api/lib/db/maintenance-db";

/** Long tasks recheck the same durable pause that prevents scheduler claims. */
export const readSchedulerJobPause = async (
  db: Pick<MaintenanceDb, "execute">,
  jobId: string,
): Promise<boolean> => {
  const rows = await db.execute<{ paused: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM scheduler_jobs
      WHERE id = ${jobId} AND paused_until > clock_timestamp()
    ) AS paused
  `);
  return (
    rows.at(0)?.paused ?? panic("Scheduler pause query omitted its result")
  );
};
