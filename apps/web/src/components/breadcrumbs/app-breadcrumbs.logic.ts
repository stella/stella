import type { RouteBreadcrumb } from "@/routes/-route-presentation";

type BreadcrumbMatch = {
  routeId: string;
  staticData: {
    presentation?: {
      breadcrumb: RouteBreadcrumb;
      parent?: Extract<RouteBreadcrumb, { type: "label" }>;
    };
  };
};

export const declaredBreadcrumbs = (matches: readonly BreadcrumbMatch[]) =>
  matches.flatMap((match) => {
    const presentation = match.staticData.presentation;
    if (presentation === undefined) {
      return [];
    }
    const decision = presentation.breadcrumb;
    if (decision.type === "inherit" || decision.type === "none") {
      return [];
    }
    return [
      ...(presentation.parent === undefined
        ? []
        : [{ decision: presentation.parent, key: `${match.routeId}:parent` }]),
      { decision, key: match.routeId },
    ];
  });

/**
 * Whether the trail's deepest crumb is the matter itself, so the header
 * stands for the matter. A document opened inside it is the deeper crumb
 * then, and the matter's own actions (pin, matter info, upload) leave the
 * header to that document's.
 */
export const trailEndsAtMatter = (matches: readonly BreadcrumbMatch[]) => {
  const deepest = declaredBreadcrumbs(matches).at(-1)?.decision;
  return deepest?.type === "entity" && deepest.entity === "matter";
};
