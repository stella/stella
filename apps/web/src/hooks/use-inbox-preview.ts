import type { QueryClient } from "@tanstack/react-query";

import {
  isNavigationFeatureEnabled,
  useNavigationFeatureEnabled,
} from "@/hooks/use-navigation-feature";
import type { WorkspaceNavigationCaller } from "@/lib/workspaces/queries.logic";

export const isInboxPreviewEnabled = async (
  queryClient: QueryClient,
  caller: WorkspaceNavigationCaller,
): Promise<boolean> =>
  await isNavigationFeatureEnabled(queryClient, { feature: "signals", caller });

export const useInboxPreviewEnabled = (): boolean =>
  useNavigationFeatureEnabled("signals");
