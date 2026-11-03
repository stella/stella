import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  group: "root-connection",
  id: "recipient-deliverability",
  capability:
    "Reading and recording the mail provider's refusal of an account address",
  owner: ["apps/api/src/lib/email/recipient-deliverability.ts"],
  summary:
    "A transactional recipient and a provider bounce or complaint name an " +
    "address, not a tenant. One module finds the account that uses the " +
    "address on the owner connection, reads whether it is refused before a " +
    "send, and records a refusal from a provider event; only the refusal " +
    "columns are touched.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/lib/email/recipient-deliverability"],
    allowed: [
      {
        path: "apps/api/src/lib/email/email.tsx",
        reason:
          "Every transactional send checks its recipient before it reaches the transport.",
      },
      {
        path: "apps/api/src/lib/scheduler/tasks/email-deliverability-receive.ts",
        reason:
          "The provider event consumer records each refusal it drains from the queue.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
