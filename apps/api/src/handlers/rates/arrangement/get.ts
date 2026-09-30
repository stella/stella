import { Result } from "better-result";
import { eq } from "drizzle-orm";

import { billingArrangements } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { billingArrangementResponse } from "@/api/lib/billing/arrangements";

const readBillingArrangement = createSafeHandler(
  {
    description:
      "Read the matter's current hourly or flat-fee billing arrangement. Null means the existing hourly rate-table behavior; call rates.arrangement.set to configure it. Issued invoices retain their own snapshots.",
    permissions: { rate: ["read"] },
    mcp: { type: "capability", reason: "billing_admin" },
    access: "read",
  },
  async function* ({ safeDb, workspaceId }) {
    const rows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            mode: billingArrangements.mode,
            currency: billingArrangements.currency,
            flatFeeAmount: billingArrangements.flatFeeAmount,
            capAmount: billingArrangements.capAmount,
            alertThresholdBps: billingArrangements.alertThresholdBps,
            revision: billingArrangements.revision,
          })
          .from(billingArrangements)
          .where(eq(billingArrangements.workspaceId, workspaceId)),
      ),
    );
    const arrangement = rows.at(0);
    return Result.ok(
      arrangement ? billingArrangementResponse(arrangement) : null,
    );
  },
);

export default readBillingArrangement;
