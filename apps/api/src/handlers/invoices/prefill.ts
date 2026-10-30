import { Result } from "better-result";
import * as v from "valibot";

import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import { readMatterInvoicePrefill } from "@/api/lib/billing/invoice-prefill-operation";
import { resourceIdSchema } from "@/api/lib/custom-schema";

const prefillInvoice = createSafeHandler(
  {
    contract: "patch",
    description:
      "Prepare a new invoice for a matter without creating it: the matter's " +
      "approved, billable, not-yet-invoiced time entries (with timekeeper names) " +
      "and approved billable expenses, oldest first (a matter with more than 500 of either is refused); the proposed " +
      "currency, issue date (today in the organization's zone) and payment term; " +
      "the default seller profile (or sellerProfileId); the buyer copied from " +
      "the matter's client; the VAT treatment and rate the lines would get, " +
      "each with where it came from; and the organization's VAT rate periods, " +
      "since billing fewer items can move the supply date into another rate. " +
      "Pass the chosen ids to invoices.create, which applies the same prefill.",
    permissions: { invoice: ["create"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    featureAccess: { featureId: "time-billing", type: "required" },
    mcp: {
      type: "capability",
      readClass: "tenant",
      reason: "billing_admin",
      consumesServices: false,
    },
    access: "read",
    query: v.object({
      sellerProfileId: v.optional(resourceIdSchema("sellerProfile")),
    }),
  },
  async function* ({ safeDb, session, workspaceId, query }) {
    const result = yield* Result.await(
      safeDb(async (tx) =>
        readMatterInvoicePrefill(tx, {
          organizationId: session.activeOrganizationId,
          workspaceId,
          sellerProfileId: query.sellerProfileId,
        }),
      ),
    );
    return result;
  },
);

export default prefillInvoice;
