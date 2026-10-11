import { createSha256 } from "@stll/sha256/bun";

import type { SafeId } from "@/api/lib/branded-types";

type HashSummarySourceOptions = {
  entityVersionId: SafeId<"entityVersion">;
  originalName: string;
  indexedTitle: string;
  searchDocumentUpdatedAt: Date | null;
};

export const hashSummarySource = ({
  entityVersionId,
  originalName,
  indexedTitle,
  searchDocumentUpdatedAt,
}: HashSummarySourceOptions): string => {
  const hasher = createSha256();
  hasher.update(entityVersionId);
  hasher.update("\n");
  hasher.update(originalName);
  hasher.update("\n");
  hasher.update(indexedTitle);
  hasher.update("\n");
  hasher.update(searchDocumentUpdatedAt?.toISOString() ?? "");
  return hasher.digest("hex");
};
