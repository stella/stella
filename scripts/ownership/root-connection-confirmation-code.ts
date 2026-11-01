import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  group: "root-connection",
  id: "root-connection-confirmation-code",
  capability: "Confirmation-code transactions on the owner connection",
  owner: ["apps/api/src/db/root.ts"],
  summary:
    "A confirmation-code request and a confirmed operation run in one owner transaction that takes the account row before any session or organization scope exists. Only the confirmation-code module opens it.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/db/root"],
    names: ["withConfirmationCodeOwnerTransaction"],
    allowed: [
      {
        path: "apps/api/src/lib/confirmation-otp.ts",
        reason:
          "Issues confirmation codes and runs confirmed work under the account row lock.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
