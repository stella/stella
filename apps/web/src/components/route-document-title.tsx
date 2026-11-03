import { useMatches } from "@tanstack/react-router";

import { pageTitleLiteral } from "@/lib/page-title";

export const RouteDocumentTitle = ({
  routeId,
  title,
}: {
  routeId: string;
  title: string;
}) => {
  const ownerRouteId = useMatches({
    select: (matches) =>
      matches.findLast(
        ({ staticData }) =>
          staticData.presentation?.breadcrumb.type === "entity",
      )?.routeId,
  });

  return ownerRouteId === routeId ? (
    <title>{pageTitleLiteral(title)}</title>
  ) : null;
};
