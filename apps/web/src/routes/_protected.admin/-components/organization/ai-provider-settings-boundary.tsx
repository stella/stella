import type { PropsWithChildren, ReactNode } from "react";

import { useChromeQuery } from "@/hooks/use-chrome-query";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { aiAvailabilityOptions } from "@/lib/organization/ai-config-queries";

/** Configuration admission is independent of permission to use chat. */
export const AIProviderSettingsBoundary = ({
  children,
}: PropsWithChildren): ReactNode => {
  const { activeOrganizationId } = useAuthenticatedUser();
  const query = useChromeQuery(
    aiAvailabilityOptions({ organizationId: activeOrganizationId }),
  );
  if (
    query.status !== "success" ||
    query.data.providerConfiguration !== "allowed"
  ) {
    return null;
  }
  return children;
};
