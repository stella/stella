import { IssuedState } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/invoice-composer";
import type { IssuedInvoice } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/invoice-composer";

const ISSUED_INVOICE = {
  id: "00000000-0000-4000-8000-000000000701",
  invoiceNumber: "2026-0017",
  issued: true,
  totalAmount: 7_659_300,
  currency: "CZK",
  dueDate: "2026-11-11",
} as const satisfies IssuedInvoice;

/** The composer's last screen once an invoice is issued. */
export const InvoiceIssuedPlayground = () => (
  <section className="w-full" data-playground-section="invoice-issued">
    <IssuedState
      buyerName="Lumen Robotics s.r.o."
      invoice={ISSUED_INVOICE}
      workspaceId="00000000-0000-4000-8000-000000000702"
    />
  </section>
);
