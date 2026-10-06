import { useQuery } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { panic } from "better-result";

import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { ensureRouteQueryData } from "@/lib/react-query";
import { useQueryView } from "@/lib/use-query-view";
import { workspacesNavigationOptions } from "@/lib/workspaces/queries";
import type { WorkspaceNavigationCaller } from "@/lib/workspaces/queries.logic";

/** Admission and navigation use the caller's server-owned enrolment decision. */
export const isTimeBillingPreviewEnabled = async (
  queryClient: QueryClient,
  caller: WorkspaceNavigationCaller,
): Promise<boolean> => {
  const features = await ensureRouteQueryData(
    queryClient,
    workspacesNavigationOptions(caller),
  );
  return features.features.timeBilling;
};

export const isTimeBillingRouteEnabled = isTimeBillingPreviewEnabled;

export const useTimeBillingPreviewEnabled = (): boolean => {
  const user = useAuthenticatedUser();
  const view = useQueryView(
    useQuery(
      workspacesNavigationOptions({
        userId: user.id,
        organizationId: user.activeOrganizationId,
      }),
    ),
  );
  switch (view.type) {
    case "pending":
    case "error":
    case "empty":
      return false;
    case "items":
      return view.items.features.timeBilling;
    default:
      view satisfies never;
      return panic(`Unknown query view: ${String(view)}`);
  }
};

export const useTimeBillingRouteEnabled = useTimeBillingPreviewEnabled;
