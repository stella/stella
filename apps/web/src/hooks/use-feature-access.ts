import { useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { panic } from "better-result";

import { useQueryView } from "@/lib/use-query-view";
import { featureAccessOptions } from "@/queries/feature-access";
import { featureIsEnabled } from "@/queries/feature-access.logic";

export const useFeatureAccess = (featureId: string): boolean => {
  const user = useRouteContext({
    from: "/_protected",
    select: (context) => context.user,
  });
  const principal = {
    organizationId: user.activeOrganizationId,
    userId: user.id,
  };
  const view = useQueryView(useQuery(featureAccessOptions(principal)));
  switch (view.type) {
    case "items":
      return featureIsEnabled(view.items, principal, featureId);
    case "pending":
    case "error":
    case "empty":
      return false;
    default:
      view satisfies never;
      return panic("Unknown feature access query state");
  }
};
