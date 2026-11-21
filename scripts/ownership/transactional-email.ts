import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "transactional-email",
  capability: "Transactional email templates and delivery",
  owner: ["apps/api/src/lib/email/smtp.ts", "packages/transactional"],
  summary:
    "`smtp.ts` owns the transport, including the TLS requirement and the " +
    "credential-pair validation. `@stll/transactional` owns the templates and " +
    "their translations, so recipient-facing copy stays localized in one place.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
