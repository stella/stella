import type { QueryClient } from "@tanstack/react-query";
import { panic } from "better-result";

import { useChromeQuery } from "@/hooks/use-chrome-query";
import { useMaybeAuthenticatedUser } from "@/lib/authenticated-user-context";
import type { fetchWorkspaceNavigationPage } from "@/lib/memory-api";
import { ensureRouteQueryData } from "@/lib/react-query";
import { useQueryView } from "@/lib/use-query-view";
import { workspacesNavigationOptions } from "@/lib/workspaces/queries";
import type { WorkspaceNavigationCaller } from "@/lib/workspaces/queries.logic";

type NavigationFeature = keyof Awaited<
  ReturnType<typeof fetchWorkspaceNavigationPage>
>["features"];

type NavigationFeatureOptions = {
  feature: NavigationFeature;
  caller: WorkspaceNavigationCaller;
};

/** Route admission shares the caller-owned decision already used by chrome. */
export const isNavigationFeatureEnabled = async (
  queryClient: QueryClient,
  { feature, caller }: NavigationFeatureOptions,
): Promise<boolean> => {
  const navigation = await ensureRouteQueryData(
    queryClient,
    workspacesNavigationOptions(caller),
  );
  return navigation.features[feature];
};

/** Anonymous public chrome cannot request or display account-only features. */
export const useNavigationFeatureEnabled = (
  feature: NavigationFeature,
): boolean => {
  const user = useMaybeAuthenticatedUser();
  const view = useQueryView(
    useChromeQuery({
      ...workspacesNavigationOptions({
        userId: user?.id ?? "",
        organizationId: user?.activeOrganizationId ?? "",
      }),
      enabled: user !== null,
    }),
  );
  if (user === null) {
    return false;
  }
  switch (view.type) {
    case "pending":
    case "error":
    case "empty":
      return false;
    case "items":
      return view.items.features[feature];
    default:
      view satisfies never;
      return panic(`Unknown query view: ${String(view)}`);
  }
};
