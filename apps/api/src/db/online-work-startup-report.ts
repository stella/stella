import { panic } from "better-result";

import { isRecord } from "@/api/lib/type-guards";

import type { OnlineMigrationConnection } from "./online-migration-connection";
import type { OnlineWorkName } from "./online-migrations";
import type { OnlineWorkLifecycle } from "./online-work-lifecycle";
import { decodeOnlineWorkState } from "./online-work-pause";
import type { ONLINE_WORK_STATES } from "./schema/online-work-state";

type OnlineWorkState = (typeof ONLINE_WORK_STATES)[number];

export type OnlineWorkStartupReport = {
  units: readonly {
    name: OnlineWorkName;
    lifecycle: OnlineWorkLifecycle["state"];
    state: OnlineWorkState;
  }[];
  pending: number;
};

type ReadOnlineWorkStartupReportOptions = {
  names: readonly OnlineWorkName[];
  lifecycle: Readonly<Record<string, OnlineWorkLifecycle>>;
};

/** Read after finalized catalog validation; this census never claims work. */
export const readOnlineWorkStartupReport = async (
  connection: Pick<OnlineMigrationConnection, "query">,
  { names, lifecycle }: ReadOnlineWorkStartupReportOptions,
): Promise<OnlineWorkStartupReport> => {
  const rows = await connection.query(
    `SELECT name, state FROM public.online_work_state
     WHERE name = ANY(string_to_array($1, ',')) LIMIT $2`,
    [names.join(","), names.length],
  );
  const states = new Map<string, OnlineWorkState>();
  for (const row of rows) {
    if (
      !isRecord(row) ||
      typeof row["name"] !== "string" ||
      typeof row["state"] !== "string"
    ) {
      panic("Online work startup state has an invalid shape");
    }
    states.set(row["name"], decodeOnlineWorkState(row["state"]));
  }
  const units = names.map((name) => {
    const entry =
      lifecycle[name] ?? panic(`Online work ${name} has no lifecycle`);
    // Finalized units were verified against the catalog. They need no runner
    // checkpoint on databases that predate the online work runner.
    const state =
      states.get(name) ?? (entry.state === "finalized" ? "done" : "pending");
    return { name, lifecycle: entry.state, state };
  });
  return {
    units,
    pending: units.filter(({ state }) => state !== "done").length,
  };
};

export const onlineWorkStartupMetric = (
  report: OnlineWorkStartupReport,
  now: number,
) => ({
  _aws: {
    Timestamp: now,
    CloudWatchMetrics: [
      {
        Namespace: "Stella/Api",
        Dimensions: [[]],
        Metrics: [{ Name: "OnlineMigrationsPending", Unit: "Count" }],
      },
    ],
  },
  event: "startup.online_migrations_pending",
  OnlineMigrationsPending: report.pending,
});
