import type { WorkspaceView } from "@/lib/types";

// The guide needs the matter's complete document collection. A filtered table
// can hide both existing documents and a document uploaded during the guide,
// so matching the presentation type alone is not a valid destination.
export const resolveGuideWorkspaceViewId = (
  views: readonly WorkspaceView[],
): string | null =>
  views.find(
    (candidate) =>
      candidate.layout.type === "table" &&
      candidate.layout.filters.length === 0,
  )?.id ?? null;

export const hasGuideWorkspaceView = (
  views: readonly WorkspaceView[],
): boolean => resolveGuideWorkspaceViewId(views) !== null;
