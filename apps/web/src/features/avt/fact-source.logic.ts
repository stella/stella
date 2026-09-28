import type { EvidenceFact } from "@/features/avt/types";
import type { WorkspaceFile } from "@/lib/workspaces/queries/entities";

type EvidenceSource = EvidenceFact["sources"][number];

/** Prefer the source that supplied the displayed quote; otherwise use the first source. */
export const evidenceQuoteSource = (
  sources: readonly EvidenceSource[],
): EvidenceSource | undefined =>
  sources.find((source) => source.quote !== null) ?? sources.at(0);

/**
 * The name a pinned source shows. A run pins each source's document name; a
 * run pinned before names were recorded falls back to the document's current
 * name, and names nothing once the document is gone.
 */
export const evidenceSourceDocumentName = (
  source: EvidenceSource,
  files: readonly Pick<WorkspaceFile, "entityId" | "name" | "fileName">[],
): string | null => {
  if (source.sourceName !== undefined) {
    return source.sourceName;
  }
  const file = files.find((entry) => entry.entityId === source.sourceEntityId);
  return file === undefined ? null : (file.name ?? file.fileName);
};
