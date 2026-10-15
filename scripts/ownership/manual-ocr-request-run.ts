import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  group: "root-connection",
  id: "manual-ocr-request-run",
  capability: "Recording a user's manual OCR request",
  owner: ["apps/api/src/lib/entity-versions/manual-ocr-request-run.ts"],
  summary:
    "A manual OCR request may promote, retry or reuse a run another requester " +
    "or an upload owns, and cancels competing manual selections, in one " +
    "serialized transaction with the entity locked. Those updates are outside " +
    "the requester's scope, so the operation runs on the owner connection; " +
    "the helper it wraps takes its connection as a required argument.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/lib/entity-versions/manual-ocr-request-run"],
    allowed: [
      {
        path: "apps/api/src/handlers/entities/ocr/create.ts",
        reason: "Records the manual OCR request the route accepted.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
