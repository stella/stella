import { Result } from "better-result";
import { eq } from "drizzle-orm";

import { billingArrangements } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import { billingArrangementResponse } from "@/api/lib/billing/arrangements";
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";

const ARRANGEMENT_COLUMNS = {
  mode: billingArrangements.mode,
  currency: billingArrangements.currency,
  flatFeeAmount: billingArrangements.flatFeeAmount,
  capAmount: billingArrangements.capAmount,
  alertThresholdBps: billingArrangements.alertThresholdBps,
  revision: billingArrangements.revision,
};
type ArrangementRow = typeof billingArrangements.$inferSelect;
const UNPROJECTED_ARRANGEMENT_COLUMNS = [
  // Request context owns the matter and organization scope.
  "workspaceId",
  "organizationId",
  // Crossing state is internal audit deduplication; the summary computes live usage.
  "thresholdState",
  "capState",
  "currencyState",
  "crossingSequence",
  // Revision is the configuration's concurrency token; update time is not part of it.
  "updatedAt",
] as const satisfies readonly (keyof ArrangementRow)[];
type MissingArrangementColumn = UnprojectedColumns<
  ArrangementRow,
  typeof ARRANGEMENT_COLUMNS,
  (typeof UNPROJECTED_ARRANGEMENT_COLUMNS)[number]
>;
type UnexpectedArrangementColumn = UnbackedProjectionKeys<
  ArrangementRow,
  typeof ARRANGEMENT_COLUMNS,
  (typeof UNPROJECTED_ARRANGEMENT_COLUMNS)[number]
>;
true satisfies MissingArrangementColumn extends never ? true : never;
true satisfies UnexpectedArrangementColumn extends never ? true : never;

const readBillingArrangement = createSafeHandler(
  {
    description:
      "Read the matter's current hourly or flat-fee billing arrangement. The arrangement field is null for the existing hourly rate-table behavior; call rates.arrangement.update to configure it. Issued invoices retain their own snapshots.",
    permissions: { rate: ["read"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    featureAccess: { featureId: "time-billing", type: "required" },
    mcp: {
      type: "capability",
      readClass: "tenant",
      reason: "billing_admin",
      consumesServices: false,
    },
    access: "read",
  },
  async function* ({ safeDb, workspaceId }) {
    const rows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select(ARRANGEMENT_COLUMNS)
          .from(billingArrangements)
          .where(eq(billingArrangements.workspaceId, workspaceId)),
      ),
    );
    const arrangement = rows.at(0);
    return Result.ok({
      arrangement: arrangement ? billingArrangementResponse(arrangement) : null,
    });
  },
);

export default readBillingArrangement;
