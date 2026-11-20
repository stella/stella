import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  group: "root-connection",
  id: "recipient-deliverability",
  capability:
    "Reading and recording the mail provider's refusals and delivery failures of an address",
  owner: ["apps/api/src/lib/email/recipient-deliverability.ts"],
  summary:
    "A transactional recipient and a provider bounce or complaint name an " +
    "address, not a tenant. One module finds the account that uses the " +
    "address on the owner connection, reads whether it is refused before a " +
    "send, records a refusal from a provider event, and records, expires " +
    "and reads why mail failed per address in the denied failure table; " +
    "only the refusal columns and that table are touched.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/lib/email/recipient-deliverability"],
    allowed: [
      {
        path: "apps/api/src/lib/auth.ts",
        reason:
          "A sign-in code request reads the address's recent failure for the sign-in screen, and a code sign-in drops it.",
      },
      {
        path: "apps/api/src/lib/email/email.tsx",
        reason:
          "Every transactional send checks its recipient before it reaches the transport, and records a dropped send as a failure.",
      },
      {
        path: "apps/api/src/lib/scheduler/tasks/email-deliverability-receive.ts",
        reason:
          "The provider event consumer records each refusal and failure it drains from the queue, and expires old failures.",
      },
      {
        path: "apps/api/src/lib/email/recipient-deliverability.db.test.ts",
        reason:
          "Exercises failure recording, supersession, retention and the drain against the migrated table.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
