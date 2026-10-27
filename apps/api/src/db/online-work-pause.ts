import { panic } from "better-result";
import { sql } from "drizzle-orm";

import type { MaintenanceDb } from "@/api/lib/db/maintenance-db";

import {
  ONLINE_WORK_LEGACY_STATES,
  ONLINE_WORK_STATES,
} from "./schema/online-work-state";

/** Remove the legacy aliases after every lifecycle-foundation task has rolled out. */
export const decodeOnlineWorkState = (value: string) =>
  ONLINE_WORK_STATES.find((state) => state === value) ??
  Object.entries(ONLINE_WORK_LEGACY_STATES).find(
    ([legacy]) => legacy === value,
  )?.[1] ??
  panic(`Unknown online work state ${value}`);

/** The database clock owns expiry, including detached work in another process. */
export const readOnlineWorkPause = async (
  db: Pick<MaintenanceDb, "execute">,
  name: string,
): Promise<boolean> => {
  const rows = await db.execute<{ paused: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM online_work_state
      WHERE name = ${name} AND paused_until > clock_timestamp()
    ) AS paused
  `);
  return rows.at(0)?.paused ?? panic("Pause query omitted its result");
};
