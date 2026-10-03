import { timeEntries } from "@/api/db/schema";
import { recordBillingCapCrossings } from "@/api/lib/billing/arrangements";

declare const tx: Parameters<typeof recordBillingCapCrossings>[0];
declare const options: Parameters<typeof recordBillingCapCrossings>[1];

export const missing = async () => {
  // oxlint-disable-next-line require-billing-cap-crossings/require-billing-cap-crossings -- fixture: missing cap reconciliation
  await tx.update(timeEntries).set({ billable: false });
};

export const reconciled = async () => {
  // expect-clean: require-billing-cap-crossings/require-billing-cap-crossings
  await tx.update(timeEntries).set({ billable: false });
  await recordBillingCapCrossings(tx, options);
};
