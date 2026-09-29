import { timeEntries } from "@/api/db/schema";
import { guardRunningTimeEntries } from "@/api/handlers/time-entries/running";

declare const tx: Parameters<typeof guardRunningTimeEntries>[0]["tx"];
declare const options: Parameters<typeof guardRunningTimeEntries>[0];

export const missing = () => {
  // oxlint-disable-next-line require-running-entry-guard/require-running-entry-guard -- fixture: missing running-entry guard
  tx.update(timeEntries);
};

export const guarded = async () => {
  const error = await guardRunningTimeEntries({ ...options, tx });
  if (error) {
    return error;
  }
  // expect-clean: require-running-entry-guard/require-running-entry-guard
  tx.update(timeEntries);
};

export const rawMissing = () => {
  // oxlint-disable-next-line require-running-entry-guard/require-running-entry-guard -- fixture: raw SQL mutation has no guard
  tx.execute(sql`UPDATE time_entries SET narrative = 'changed'`);
};
