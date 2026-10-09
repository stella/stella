import type { QueryClient } from "@tanstack/react-query";

import {
  isNavigationFeatureEnabled,
  useNavigationFeatureEnabled,
} from "@/hooks/use-navigation-feature";
import type { WorkspaceNavigationCaller } from "@/lib/workspaces/queries.logic";

export const workflowsRouteAvailable = async (
  queryClient: QueryClient,
  caller: WorkspaceNavigationCaller,
): Promise<boolean> =>
  await isNavigationFeatureEnabled(queryClient, { feature: "flows", caller });

export const useWorkflowsPreviewEnabled = (): boolean =>
  useNavigationFeatureEnabled("flows");
