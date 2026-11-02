import { useSyncExternalStore } from "react";

import { useQuery } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { panic } from "better-result";

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
 * The server's decision as a yes or no: false until it answers. Anything that
 * sends a request or admits a route reads this one.
 */
export const useTimeBillingPreviewEnabled = (): boolean =>
  useTimeBillingDecision() === true;

export const useTimeBillingRouteEnabled = useTimeBillingPreviewEnabled;

/**
 * What the chrome shows (navigation entries, the timer's place, commands).
 * Until the server answers, a reload keeps what it last said, so a caller who
 * has time billing does not see it drop out and return. Never gate a request
 * on it: a revoked grant would still send one before the answer arrives.
 */
export const useTimeBillingChromeEnabled = (): boolean => {
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
