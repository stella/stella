import type { RouteBreadcrumb } from "@/lib/route-presentation";

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
