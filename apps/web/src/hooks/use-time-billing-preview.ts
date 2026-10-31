import { useSyncExternalStore } from "react";

import { useQuery } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { panic } from "better-result";

import { usePermissions } from "@/hooks/use-permissions";
import { roleOptions } from "@/lib/auth-queries";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { queryView } from "@/lib/query-view.logic";
import { ensureRouteQueryData } from "@/lib/react-query";
import { workspacesNavigationOptions } from "@/lib/workspaces/queries";
import type { WorkspaceNavigationCaller } from "@/lib/workspaces/queries.logic";
import { rememberedTimeBillingAccess } from "@/lib/workspaces/time-billing-access-memory";

/** Admission and navigation use the caller's server-owned enrolment decision. */
export const isTimeBillingPreviewEnabled = async (
  queryClient: QueryClient,
  caller: WorkspaceNavigationCaller,
): Promise<boolean> => {
  const navigation = await ensureRouteQueryData(
    queryClient,
    workspacesNavigationOptions(caller),
  );
  return navigation.features.timeBilling;
};

export const isTimeBillingRouteEnabled = isTimeBillingPreviewEnabled;

const neverChanges = () => () => undefined;

/**
 * The server's decision, or `null` until it answers. Requests wait for this
 * one, so the kill switch never sends a timers call on an old answer.
 */
export const useTimeBillingDecision = (): boolean | null => {
  const user = useAuthenticatedUser();
  const view = queryView(
    useQuery(
      workspacesNavigationOptions({
        userId: user.id,
        organizationId: user.activeOrganizationId,
      }),
    ),
  );
  switch (view.type) {
    case "pending":
      return null;
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

/**
 * What the chrome shows. Until the server answers, a reload keeps what it last
 * said, so a caller who has time billing does not see it drop out and return.
 */
export const useTimeBillingPreviewEnabled = (): boolean => {
  const user = useAuthenticatedUser();
  const decision = useTimeBillingDecision();
  const remembered = useSyncExternalStore(
    neverChanges,
    () =>
      decision === null &&
      rememberedTimeBillingAccess(user.activeOrganizationId),
    () => false,
  );
  return decision ?? remembered;
};

export const useTimeBillingRouteEnabled = useTimeBillingPreviewEnabled;

/** The time surfaces in the chrome; a role still loading keeps them in place. */
export const useTimeChromeVisible = (): boolean => {
  const enabled = useTimeBillingPreviewEnabled();
  const canRead = usePermissions({ timeEntry: ["read"] });
  const rolePending = useQuery(roleOptions).isPending;
  return enabled && (canRead || rolePending);
};
