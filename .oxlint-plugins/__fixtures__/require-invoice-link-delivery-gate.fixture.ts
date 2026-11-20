import { Result as R } from "better-result";
import { deliverInvoiceLink } from "@/api/handlers/invoice-links/delivery";
import { createSafeTokenHandler } from "@/api/lib/api-handlers";

// oxlint-disable-next-line require-invoice-link-delivery-gate/require-invoice-link-delivery-gate -- fixture rejects a direct successful public response even when another response uses the gate
export const directSuccess = createSafeTokenHandler(() => R.ok(response));

export const asynchronousResponse = deliverInvoiceLink({
  // oxlint-disable-next-line require-invoice-link-delivery-gate/require-invoice-link-delivery-gate -- fixture rejects asynchronous work after the final delivery check
  response: async () => await Promise.resolve(response),
});

// expect-clean: require-invoice-link-delivery-gate/require-invoice-link-delivery-gate
export const gatedSuccess = createSafeTokenHandler(
  async () => await deliverInvoiceLink({ response: () => response }),
);

// expect-clean: require-invoice-link-delivery-gate/require-invoice-link-delivery-gate
export const refused = createSafeTokenHandler(() => R.err(error));
