import { createElement } from "react";

import { expectTypeOf } from "bun:test";

import type { PublicCaseLawDecision } from "@/features/case-law/public-decision";
import type { WebApiRoutes } from "@/lib/api";
import {
  InvoiceSendsSection,
  SendInvoiceForm,
} from "@/routes/_protected.workspaces/$workspaceId/-components/billing/invoice-sends";

// JSON carries a timestamp column as its ISO string and the client never
// revives it, so a response type claiming `Date` would let `.getTime()`
// type-check and throw at runtime.

expectTypeOf<PublicCaseLawDecision["createdAt"]>().toEqualTypeOf<string>();
expectTypeOf<PublicCaseLawDecision["updatedAt"]>().toEqualTypeOf<string>();

expectTypeOf<
  WebApiRoutes["workspaces"][":workspaceId"]["get"]["response"][200]["createdAt"]
>().toEqualTypeOf<string>();

// Caller-gated entry points cannot be rendered without owner admission.
const renderUngatedInvoiceControls = () => {
  // @ts-expect-error Invoice email requires feature admission.
  createElement(SendInvoiceForm, {
    workspaceId: "matter",
    invoiceId: "invoice",
    invoiceNumber: "2026-1",
    recipients: null,
    onClose: () => undefined,
  });
  createElement(InvoiceSendsSection, {
    workspaceId: "matter",
    invoiceId: "invoice",
    // @ts-expect-error Sending again requires the same owner admission.
    sendControl: { type: "available", onSendAgain: () => undefined },
  });
};
expectTypeOf(renderUngatedInvoiceControls).toBeFunction();
