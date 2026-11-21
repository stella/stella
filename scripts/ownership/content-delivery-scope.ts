import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "content-delivery-scope",
  capability: "Running and checking the content-delivery scope",
  owner: ["apps/api/src/lib/files/content-delivery.ts"],
  summary:
    "The handler invocation owns the delivery scope; response and audit " +
    "owners record their corresponding events through named entry points.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/lib/files/content-delivery"],
    names: ["runWithContentDeliveryScope", "getContentDeliveryReceiptError"],
    allowed: [
      {
        path: "apps/api/src/lib/api-handlers.ts",
        reason: "Runs and checks the scope around the handler invocation.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
