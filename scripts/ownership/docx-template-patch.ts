import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "docx-template-patch",
  capability: "Rewriting OOXML parts inside an uploaded DOCX template",
  owner: ["apps/api/src/lib/docx/", "packages/docx-utils/"],
  summary:
    "Template patching edits the parts of a file a user supplied, preserving " +
    "everything it does not touch. It shares only the zip and namespace " +
    "helpers with `docx-authoring`. A third DOCX writer is not to be started.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
