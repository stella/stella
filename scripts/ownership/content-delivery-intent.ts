import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "content-delivery-intent",
  capability: "Recording stored-content delivery intent",
  owner: ["apps/api/src/lib/files/content-delivery.ts"],
  summary:
    "The handler invocation owns the delivery scope; response and audit " +
    "owners record their corresponding events through named entry points.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/lib/files/content-delivery"],
    names: ["markContentDeliveryIntent"],
    allowed: [
      {
        path: "apps/api/src/lib/api-handlers.ts",
        reason:
          "Records intent for file bodies and disposition headers at the response boundary.",
      },
      {
        path: "apps/api/src/lib/secure-document-response.ts",
        reason: "Records intent when constructing a stored-content response.",
      },
      {
        path: "apps/api/src/lib/s3-presign.ts",
        reason: "Records intent when granting a stored-content URL.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
