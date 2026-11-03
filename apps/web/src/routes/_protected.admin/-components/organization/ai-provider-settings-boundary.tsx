import type { PropsWithChildren, ReactNode } from "react";

import { QueryViewFeedback } from "@/components/query-view-feedback";
import { useChromeQuery } from "@/hooks/use-chrome-query";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { aiAvailabilityOptions } from "@/lib/organization/ai-config-queries";
import { queryView } from "@/lib/query-view.logic";
import { useQueryViewError } from "@/lib/use-query-view";

/** Configuration admission is independent of permission to use chat. */
export const AIProviderSettingsBoundary = ({
  children,
}: PropsWithChildren): ReactNode => {
  const { activeOrganizationId } = useAuthenticatedUser();
  const query = useChromeQuery(
    aiAvailabilityOptions({ organizationId: activeOrganizationId }),
  );
  const view = queryView(query);
  useQueryViewError(view, "AIProviderSettingsBoundary:availability-query");
  if (view.type !== "items" || view.refetchError !== undefined) {
    return <QueryViewFeedback view={view} />;
  }
  if (view.items.providerConfiguration !== "allowed") {
    return null;
  }
  return children;
};
