import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "template-version-publication",
  capability: "Publishing stored template DOCX revisions and version history",
  owner: [
    "apps/api/src/lib/templates/write-template.ts",
    "apps/api/src/lib/templates/create-template.ts",
  ],
  summary:
    "Existing-template writes prepare and upload outside transactions, then " +
    "publish against the exact snapshot with durable cleanup ownership and " +
    "transactional audit. Initial creation has its own owner. " +
    "`no-direct-template-version-write` confines version-row mutations to these owners.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
