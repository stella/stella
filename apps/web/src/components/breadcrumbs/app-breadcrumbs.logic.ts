import type { RouteBreadcrumb } from "@/lib/route-presentation";

type BreadcrumbMatch = {
  routeId: string;
  staticData: {
    presentation?: { breadcrumb: RouteBreadcrumb };
  };
};

export const declaredBreadcrumbs = (matches: readonly BreadcrumbMatch[]) =>
  matches.flatMap((match) => {
    const decision = match.staticData.presentation?.breadcrumb;
    if (
      decision === undefined ||
      decision.type === "inherit" ||
      decision.type === "none"
    ) {
      return [];
    }
    return [{ decision, key: match.routeId }];
  });
