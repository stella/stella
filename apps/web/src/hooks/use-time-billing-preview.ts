import type { QueryClient } from "@tanstack/react-query";

import {
  isNavigationFeatureEnabled,
  useNavigationFeatureEnabled,
} from "@/hooks/use-navigation-feature";
import type { WorkspaceNavigationCaller } from "@/lib/workspaces/queries.logic";

export const isTimeBillingPreviewEnabled = async (
  queryClient: QueryClient,
  caller: WorkspaceNavigationCaller,
): Promise<boolean> =>
  await isNavigationFeatureEnabled(queryClient, {
    feature: "timeBilling",
    caller,
  });

export const useTimeBillingPreviewEnabled = (): boolean =>
  useNavigationFeatureEnabled("timeBilling");

export const isTimeBillingRouteEnabled = isTimeBillingPreviewEnabled;
export const useTimeBillingRouteEnabled = useTimeBillingPreviewEnabled;
