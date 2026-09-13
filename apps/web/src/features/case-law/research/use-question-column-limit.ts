import { useQuery } from "@tanstack/react-query";

import { CASE_LAW_RESEARCH_COLUMNS_PER_ORGANIZATION_MAX } from "@stll/api-contract";

import { questionColumnsOptions } from "@/features/case-law/research/queries";
import { useClientAuthStatus } from "@/hooks/use-client-auth-status";

/**
 * Whether the organization already holds every question column it may add.
 *
 * The cap is a product constant shared with the API, so only the current count
 * is fetched; while it is loading the control stays available and the server
 * refuses past the cap, the way the matter's properties cap behaves.
 */
export const useQuestionColumnsCountLimit = (enabled: boolean): boolean => {
  const authStatus = useClientAuthStatus();
  const activeOrganizationId = authStatus.isAuthenticated
    ? authStatus.user.activeOrganizationId
    : null;
  const { data: count } = useQuery({
    ...questionColumnsOptions({
      activeOrganizationId: activeOrganizationId ?? "",
    }),
    enabled: enabled && activeOrganizationId !== null,
    select: (columns) => columns.length,
  });

  return (
    count !== undefined &&
    count >= CASE_LAW_RESEARCH_COLUMNS_PER_ORGANIZATION_MAX
  );
};
