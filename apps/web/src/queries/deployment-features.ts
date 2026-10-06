import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { STALE_TIME } from "@/lib/consts";
import { unwrapEden } from "@/lib/errors/api";

export type DeploymentFeaturesCaller = {
  userId: string;
  organizationId: string;
};

/**
 * Features this server serves to the authenticated caller. The answer is per
 * caller (a member's own Beta enrolment), so the key names the user and the
 * organization: another account signed in on the same browser never reads
 * this caller's cached answer.
 */
export const deploymentFeaturesOptions = ({
  userId,
  organizationId,
}: DeploymentFeaturesCaller) =>
  queryOptions({
    queryKey: ["deployment-features", userId, organizationId] as const,
    queryFn: async ({ signal }) => {
      const response = await api["organization-settings"][
        "deployment-features"
      ].get({ fetch: { signal } });

      return unwrapEden(response);
    },
    staleTime: STALE_TIME.FIVE.MINUTES,
  });
