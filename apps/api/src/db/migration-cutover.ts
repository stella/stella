import { panic, TaggedError } from "better-result";
import * as v from "valibot";

import type { MigrationDrainConfirmation } from "../env-migration";
import type { OnlineMigrationConnection } from "./online-migration-connection";

const RECENT_SCHEDULER_LEASE_WINDOW_MS = 10 * 60_000;

export type MigrationCutoverEvent = {
  event: "migrate.manual_drain_confirmed";
  reason: string;
  tableCount: number;
};

export class MigrationSchedulerDrainRequired extends TaggedError(
  "MigrationSchedulerDrainRequired",
)<{ message: string }> {}

type AssertMigrationCutoverOptions = {
  connection: Pick<OnlineMigrationConnection, "query">;
  tables: readonly string[];
  confirmation: MigrationDrainConfirmation;
  emit?: (event: MigrationCutoverEvent) => void;
};

/** Read-only admission precedes role bootstrap, ledger adoption, and all migration DDL. */
export const assertMigrationCutover = async ({
  connection,
  tables,
  confirmation,
  emit = (event) => {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  },
}: AssertMigrationCutoverOptions) => {
  if (tables.length === 0) {
    return;
  }
  switch (confirmation.type) {
    case "manual":
      emit({
        event: "migrate.manual_drain_confirmed",
        reason: confirmation.reason,
        tableCount: tables.length,
      });
      return;
    case "automatic":
      break;
    default:
      confirmation satisfies never;
      return panic("Unknown migration drain confirmation");
  }
  const [{ jobsExist, activityExists }] = v.parse(
    v.tuple([
      v.object({ jobsExist: v.boolean(), activityExists: v.boolean() }),
    ]),
    await connection.query(
      `SELECT to_regclass('public.scheduler_jobs') IS NOT NULL AS "jobsExist",
       to_regclass('public.scheduler_table_lease_activity') IS NOT NULL AS "activityExists"`,
    ),
  );
  if (!jobsExist) {
    return;
  }
  const [{ active }] = v.parse(
    v.tuple([v.object({ active: v.boolean() })]),
    await connection.query(
      `SELECT EXISTS (SELECT 1 FROM public.scheduler_jobs
       WHERE (locked_by IS NOT NULL AND locked_until > clock_timestamp())
          OR last_run_at > clock_timestamp() - $1::integer * interval '1 millisecond') AS active`,
      [RECENT_SCHEDULER_LEASE_WINDOW_MS],
    ),
  );
  if (!active) {
    return;
  }
  if (activityExists) {
    const [{ recent }] = v.parse(
      v.tuple([v.object({ recent: v.boolean() })]),
      await connection.query(
        `SELECT EXISTS (SELECT 1 FROM public.scheduler_table_lease_activity
       WHERE slot = 0 AND last_claimed_at > clock_timestamp() - $1::integer * interval '1 millisecond') AS recent`,
        [RECENT_SCHEDULER_LEASE_WINDOW_MS],
      ),
    );
    if (recent) {
      return;
    }
  }
  throw new MigrationSchedulerDrainRequired({
    message:
      "Active or recently running scheduler workers have no lease-aware claim in the last 10 minutes; run the manual scheduler drain, then re-run migrate with MIGRATE_MANUAL_DRAIN_CONFIRMED=<reason>",
  });
};
