import type { OwnershipEntry } from "../ownership-types.ts";
import MODEL_OPERATIONS from "./model-operation-callers.ts";

export default {
  id: "generated-artefact-provenance",
  capability: "Constructing and persisting generated artefacts",
  owner: [
    "apps/api/src/lib/generated-artefact-provenance.ts",
    ...MODEL_OPERATIONS.owner,
  ],
  summary:
    "Registered model operations use the typed generated/authored value boundary. The provenance census freezes existing raw calls in a shrink-only transition list; new operations require explicit sources. The owner writes value and provenance atomically and delegates read projection to withdrawn-copy projection.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/lib/generated-artefact-provenance"],
    names: ["generateArtefact", "authorArtefact", "writeThreadArtefactTitle"],
    allowed: [],
  },
} as const satisfies OwnershipEntry;
