import type { GuideRoute } from "@/features/guides/guide-types";
import type { WorkspaceView } from "@/lib/types";

type GuideWorkspaceRoute = Extract<GuideRoute, { type: "workspace-view" }>;

// The guide needs the matter's complete document collection. A filtered table
// can hide both existing documents and a document uploaded during the guide,
// so matching the presentation type alone is not a valid destination.
export const resolveGuideWorkspaceViewId = (
  views: readonly WorkspaceView[],
  target: GuideWorkspaceRoute["target"],
): string | null =>
  views.find((candidate) => {
    switch (target) {
      case "unfiltered-table":
        return (
          candidate.layout.type === "table" &&
          candidate.layout.filters.length === 0
        );
      default:
        target satisfies never;
        return false;
    }
  })?.id ?? null;

export const hasGuideWorkspaceView = (
  views: readonly WorkspaceView[],
): boolean => resolveGuideWorkspaceViewId(views, "unfiltered-table") !== null;
