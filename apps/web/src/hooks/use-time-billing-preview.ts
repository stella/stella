import { useQuery } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { panic } from "better-result";

import { env } from "@/env";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { ensureRouteQueryData, prefetchRouteQuery } from "@/lib/react-query";
import { useQueryView } from "@/lib/use-query-view";
import { deploymentFeaturesOptions } from "@/queries/deployment-features";
import type { DeploymentFeaturesCaller } from "@/queries/deployment-features";

/** The build flag is the explicit self-hosted override; otherwise the server owns access. */
export const isTimeBillingPreviewEnabled = async (
  queryClient: QueryClient,
  caller: DeploymentFeaturesCaller,
): Promise<boolean> => {
  if (env.VITE_FEATURE_TIME_BILLING) {
    return true;
  }
  const features = await ensureRouteQueryData(
    queryClient,
    deploymentFeaturesOptions(caller),
  );
  return features.timeBilling;
};

export const isTimeBillingRouteEnabled = isTimeBillingPreviewEnabled;

type PrefetchTimeBillingServerStateOptions = {
  queryClient: QueryClient;
  caller: DeploymentFeaturesCaller;
  onError: (error: unknown) => void;
};

/** Prime the caller's decision before navigation surfaces render. */
export const prefetchTimeBillingServerState = async ({
  queryClient,
  caller,
  onError,
}: PrefetchTimeBillingServerStateOptions): Promise<void> => {
  if (env.VITE_FEATURE_TIME_BILLING) {
    return;
  }
  await prefetchRouteQuery(
    queryClient,
    deploymentFeaturesOptions(caller),
    onError,
  );
};

export const useTimeBillingPreviewEnabled = (): boolean => {
  const user = useAuthenticatedUser();
  const view = useQueryView(
    useQuery({
      ...deploymentFeaturesOptions({
        userId: user.id,
        organizationId: user.activeOrganizationId,
      }),
      enabled: !env.VITE_FEATURE_TIME_BILLING,
    }),
  );
  if (env.VITE_FEATURE_TIME_BILLING) {
    return true;
  }
  switch (view.type) {
    case "pending":
    case "error":
    case "empty":
      return false;
    case "items":
      return view.items.timeBilling;
    default:
      view satisfies never;
      return panic(`Unknown query view: ${String(view)}`);
  }
};

export const useTimeBillingRouteEnabled = useTimeBillingPreviewEnabled;
