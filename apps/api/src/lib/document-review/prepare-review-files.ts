import { panic } from "better-result";

import type { SafeId } from "@/api/lib/branded-types";
import { fetchAndPrepareFiles } from "@/api/lib/workflow/generate-batch";
import type { PreparedInputFile } from "@/api/lib/workflow/generate-batch";
import type { ResolvedFile } from "@/api/lib/workflow/generate-batch-shared";

export type ReviewFile = ResolvedFile & { workspaceId: SafeId<"workspace"> };

type IndexedReviewFile = { index: number; file: ReviewFile };

/**
 * Prepare a review's documents when they span matters. Storage keys carry the
 * owning matter, so each matter's files are fetched under their own key
 * prefix, and the results are put back in request order with the position
 * labels (`F0`, `F1`, …) the prompts cite reassigned to that order.
 */
export const fetchAndPrepareReviewFiles = async (
  files: readonly ReviewFile[],
  organizationId: SafeId<"organization">,
): Promise<PreparedInputFile[]> => {
  const groups = new Map<SafeId<"workspace">, IndexedReviewFile[]>();
  for (const [index, file] of files.entries()) {
    let group = groups.get(file.workspaceId);
    if (group === undefined) {
      group = [];
      groups.set(file.workspaceId, group);
    }
    group.push({ index, file });
  }

  const prepared = new Map<number, PreparedInputFile>();
  await Promise.all(
    [...groups].map(async ([workspaceId, group]) => {
      const groupFiles = await fetchAndPrepareFiles(
        group.map(({ file }) => file),
        organizationId,
        workspaceId,
      );
      for (const [position, file] of groupFiles.entries()) {
        const index =
          group[position]?.index ??
          panic("Prepared review files do not line up with their request");
        prepared.set(index, { ...file, simplifiedName: `F${String(index)}` });
      }
    }),
  );

  return files.map(
    (_, index) =>
      prepared.get(index) ??
      panic(`Review file ${String(index)} was not prepared`),
  );
};
