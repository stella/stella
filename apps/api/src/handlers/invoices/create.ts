import { Result } from "better-result";

import { resultTx } from "@/api/db/safe-db";
import { invoiceRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import { createInvoiceBodySchema } from "@/api/lib/billing/invoice-create-contract";
import {
  createDraftInvoice,
  createInvoiceInput,
  invoiceCreationError,
} from "@/api/lib/billing/invoice-create-operation";

const createInvoice = createSafeHandler(
  {
    contract: "patch",
    description:
      "Create a draft invoice from approved, not-yet-invoiced client time " +
      "entries in a matter, marking them billed. Hourly invoices require " +
      "billable entries in the invoice currency and calculate time charges " +
      "from their billed minutes and recorded rates; nothing is converted. The " +
      "optional invoice number must not already be in use. An omitted number " +
      "is allocated from the document type’s default series at finalize. Credit " +
      "notes require an original finalized, sent, or paid invoice in the same matter. " +
      "A flat-fee matter snapshots its agreed fee as one protected manual line; selected approved client entries are covered without time charges. Hourly matters reserve time charges against any cap and refuse an excess without write-down. " +
      "Pass empty timeEntryIds for a draft with manual lines. expenseIds bills " +
      "approved expenses in the same call. entryAdjustments sets billed minutes " +
      "and no-charge on included entries first (approvers only). The draft is " +
      "prefilled like invoices.prefill returns it: the default seller profile " +
      "(or sellerProfileId), the buyer copied from the matter's client, every " +
      "line's VAT from the seller's VAT-payer flag and the buyer (not a VAT payer, " +
      "reverse charge when the client's VAT ID names another country, or the highest organization VAT rate in force), the taxable " +
      "supply date as the last included work day, and the due date from the " +
      "client's payment term or 14 days; explicit dueDate and taxableSupplyDate win. " +
      "Without a seller profile, lines keep 0 % VAT. Credit notes are not prefilled.",
    permissions: { invoice: ["create"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    featureAccess: { featureId: "time-billing", type: "required" },
    realtime: invoiceRealtimeUpdates,
    mcp: {
      type: "capability",
      reason: "billing_admin",
      consumesServices: false,
    },
    body: createInvoiceBodySchema,
  },
  async function* ({
    safeDb,
    user,
    memberRole,
    session,
    workspaceId,
    body,
    recordAuditEvent,
  }) {
    const result = yield* Result.await(
      resultTx(
        safeDb,
        async (tx) =>
          await createDraftInvoice(tx, {
            actorUserId: user.id,
            memberRole,
            organizationId: session.activeOrganizationId,
            workspaceId,
            body: createInvoiceInput(body),
            now: new Date(),
            recordAuditEvent,
          }),
      ).then((txResult) => txResult.mapError(invoiceCreationError)),
    );
    return Result.ok(result);
  },
);

export default createInvoice;
