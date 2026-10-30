import { panic, TaggedError } from "better-result";
import * as v from "valibot";

import type { MigrationDrainConfirmation } from "../env-migration";
import type { OnlineMigrationConnection } from "./online-migration-connection";
import { SCHEDULER_EXECUTION_EVIDENCE_MS } from "./table-lease-queue";

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
  const [{ jobsExist, runsExist, activityExists }] = v.parse(
    v.tuple([
      v.object({
        jobsExist: v.boolean(),
        runsExist: v.boolean(),
        activityExists: v.boolean(),
      }),
    ]),
    await connection.query(
      `SELECT to_regclass('public.scheduler_jobs') IS NOT NULL AS "jobsExist",
       to_regclass('public.scheduler_job_runs') IS NOT NULL AS "runsExist",
       to_regclass('public.scheduler_table_lease_activity') IS NOT NULL AS "activityExists"`,
    ),
  );
  const executions = [
    ...(jobsExist
      ? [
          `SELECT id AS job_id, locked_by AS execution_token, NULL::uuid AS run_id
          FROM public.scheduler_jobs
          WHERE locked_by IS NOT NULL AND locked_until > clock_timestamp()`,
        ]
      : []),
    ...(runsExist
      ? [
          `SELECT job_id, NULL::text AS execution_token, id AS run_id
          FROM public.scheduler_job_runs
          WHERE started_at > clock_timestamp() - $1::integer * interval '1 millisecond'
             OR finished_at > clock_timestamp() - $1::integer * interval '1 millisecond'`,
        ]
      : []),
  ];
  if (executions.length === 0) {
    return;
  }
  const [{ uncovered }] = v.parse(
    v.tuple([v.object({ uncovered: v.boolean() })]),
    await connection.query(
      `SELECT EXISTS (SELECT 1 FROM (${executions.join(" UNION ALL ")}) execution
       ${
         activityExists
           ? `WHERE NOT EXISTS (
         SELECT 1 FROM public.scheduler_table_lease_activity claim
         WHERE claim.job_id = execution.job_id
           AND claim.expires_at > clock_timestamp()
           AND ((execution.execution_token IS NOT NULL AND claim.execution_token = execution.execution_token)
             OR (execution.run_id IS NOT NULL AND claim.run_id = execution.run_id)))`
           : ""
       }
       ) AS uncovered`,
      runsExist ? [SCHEDULER_EXECUTION_EVIDENCE_MS] : [],
    ),
  );
  if (!uncovered) {
    return;
  }
  throw new MigrationSchedulerDrainRequired({
    message:
      "An active or recent scheduler execution has no matching table-lease claim; run the manual scheduler drain, then re-run migrate with MIGRATE_MANUAL_DRAIN_CONFIRMED=<reason>",
  });
};
