import { invoices } from "@/api/db/schema";
import { defineTransitions } from "@/api/lib/db/transitions";

// An invoice's lifecycle. Recorded payments move a finalized or sent invoice
// to paid and back (`lib/billing/invoice-payments`) through this spec;
// finalize, send, revert and void are still direct writes of the transition
// handler in the shrinking ledger.
export const INVOICE_TRANSITIONS = defineTransitions(
  invoices,
  {
    draft: ["finalized"],
    finalized: ["draft", "sent", "paid", "void"],
    sent: ["paid", "void"],
    paid: ["finalized", "sent", "void"],
    void: [],
  },
  { terminal: ["void"] },
);
