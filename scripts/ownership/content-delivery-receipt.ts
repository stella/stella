import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "content-delivery-receipt",
  capability: "Recording a content-delivery audit receipt",
  owner: ["apps/api/src/lib/files/content-delivery.ts"],
  summary:
    "The handler invocation owns the delivery scope; response and audit " +
    "owners record their corresponding events through named entry points.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/lib/files/content-delivery"],
    names: ["recordContentDeliveryReceipt"],
    allowed: [
      {
        path: "apps/api/src/lib/audited-download.ts",
        reason: "Records a receipt after the content-grant audit write.",
      },
      {
        path: "apps/api/src/lib/audit-log-core.ts",
        reason: "Records a receipt after a content-access audit write.",
      },
      {
        path: "apps/api/src/tests/helpers/audit-recorder-double.ts",
        reason:
          "The handler-test audit recorder double issues the receipt the production recorder issues for an access event.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
