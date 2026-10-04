import { AsyncLocalStorage } from "node:async_hooks";

import { HandlerError } from "@/api/lib/errors/tagged-errors";

export type ContentDelivery =
  | { type: "audited" }
  | { type: "public"; reason: string }
  | { type: "none"; reason: string };

type DeliveryScope = {
  declaration: ContentDelivery | undefined;
  intent: "absent" | "present";
  receipt: "pending" | "recorded";
};

const deliveryScope = new AsyncLocalStorage<DeliveryScope>();

export const runWithContentDeliveryScope = <T>(
  declaration: ContentDelivery | undefined,
  run: () => T,
): T =>
  deliveryScope.run({ declaration, intent: "absent", receipt: "pending" }, run);

export const markContentDeliveryIntent = (): void => {
  const scope = deliveryScope.getStore();
  if (scope) {
    scope.intent = "present";
  }
};

/** Only the audit owners issue a receipt, after their awaited row insert. */
export const recordContentDeliveryReceipt = (): void => {
  const scope = deliveryScope.getStore();
  if (scope) {
    scope.receipt = "recorded";
  }
};

export const getContentDeliveryReceiptError = (): HandlerError | undefined => {
  const scope = deliveryScope.getStore();
  if (!scope || scope.intent === "absent") {
    return undefined;
  }
  if (scope.declaration?.type !== "audited" || scope.receipt === "recorded") {
    return undefined;
  }
  return new HandlerError({
    status: 500,
    message: "Could not complete content delivery.",
  });
};
