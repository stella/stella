import { panic, TaggedError } from "better-result";
import * as v from "valibot";

import type { MigrationDrainConfirmation } from "../env-migration";
import type { OnlineMigrationConnection } from "./online-migration-connection";
import { TABLE_LEASE_PROTOCOL } from "./table-lease-protocol";

export type MigrationCutoverEvent =
  | {
      event: "migrate.manual_drain_confirmed";
      reason: string;
      tableCount: number;
    }
  | {
      event: "migrate.table_lease_protocol_bootstrapped";
      protocol: typeof TABLE_LEASE_PROTOCOL;
      tableCount: number;
    };

export class MigrationSchedulerDrainRequired extends TaggedError(
  "MigrationSchedulerDrainRequired",
)<{ message: string }> {}

type AssertMigrationCutoverOptions = {
  connection: Pick<OnlineMigrationConnection, "query">;
  tables: readonly string[];
  confirmation: MigrationDrainConfirmation;
  bootstrapProtocol: () => Promise<void>;
  emit?: (event: MigrationCutoverEvent) => void;
};

/** Fresh protocol storage and activation commit in the caller's admission transaction. */
export const assertMigrationCutover = async ({
  connection,
  tables,
  confirmation,
  bootstrapProtocol,
  emit = (event) => {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  },
}: AssertMigrationCutoverOptions) => {
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
      panic("Unknown migration drain confirmation");
  }
  // Cutover rollout replaces every runner; rollback below this protocol must clear the marker or use the manual drain.
  const [{ markerExists, jobsExist }] = v.parse(
    v.tuple([v.object({ markerExists: v.boolean(), jobsExist: v.boolean() })]),
    await connection.query(
      `SELECT to_regclass('public.scheduler_table_lease_protocol') IS NOT NULL AS "markerExists",
       to_regclass('public.scheduler_jobs') IS NOT NULL AS "jobsExist"`,
    ),
  );
  if (markerExists) {
    const [{ live }] = v.parse(
      v.tuple([v.object({ live: v.boolean() })]),
      await connection.query(
        "SELECT EXISTS (SELECT 1 FROM public.scheduler_table_lease_protocol WHERE protocol = $1) AS live",
        [TABLE_LEASE_PROTOCOL],
      ),
    );
    if (live) {
      return;
    }
  }
  const hasHistory = jobsExist
    ? v.parse(
        v.tuple([v.object({ hasHistory: v.boolean() })]),
        await connection.query(
          'SELECT EXISTS (SELECT 1 FROM public.scheduler_jobs) AS "hasHistory"',
        ),
      )[0].hasHistory
    : false;
  if (!hasHistory) {
    // No runner has registered here: every future client belongs to this protocol.
    await bootstrapProtocol();
    emit({
      event: "migrate.table_lease_protocol_bootstrapped",
      protocol: TABLE_LEASE_PROTOCOL,
      tableCount: tables.length,
    });
    return;
  }
  throw new MigrationSchedulerDrainRequired({
    message:
      "The table-lease protocol marker is absent for a database with scheduler history; run the manual scheduler drain, then re-run migrate with MIGRATE_MANUAL_DRAIN_CONFIRMED=<reason>",
  });
};
