import type { QueryClient } from "@tanstack/react-query";
import { redirect } from "@tanstack/react-router";
import { panic } from "better-result";

import { PROFESSIONAL_USE_STATUS } from "@stll/api-contract/professional-use";

import { isInboxPreviewEnabled } from "@/hooks/use-inbox-preview";
import { isTimeBillingRouteEnabled } from "@/hooks/use-time-billing-preview";
import { getAnalytics } from "@/lib/analytics/provider";
import { professionalUseOptions, roleOptions } from "@/lib/auth-queries";
import { detached } from "@/lib/detached";
import { notificationsOptions } from "@/lib/notification-queries";
import { aiAvailabilityOptions } from "@/lib/organization/ai-config-queries";
import {
  ensureRouteQueryData,
  prefetchNonCriticalInfiniteQuery,
  prefetchRouteQuery,
} from "@/lib/react-query";
import { returnPathOf } from "@/lib/redirect";
import { organizationSettingsOptions } from "@/queries/organization-settings";
import { loadAuthContext } from "@/routes/-auth-context";

// The signed-in routes' guard, apart from the signed-in frame so a route can
// run it without loading the frame.

type ProtectedRouteArgs = {
  context: { queryClient: QueryClient };
  location: { pathname: string; searchStr: string };
};

/**
 * `_protected`'s `beforeLoad`: sends a visitor without a session to sign in,
 * one without an organization to pick one, and one whose account has not
 * accepted the professional-use statement to accept it; starts the shell's
 * optional data, and returns the signed-in user as route context.
 */
export const loadProtectedContext = async ({
  context,
  location,
}: ProtectedRouteArgs) => {
  const authContext = await loadAuthContext(context.queryClient);

  const redirectTo = returnPathOf(location);

  if (!authContext.session || !authContext.user) {
    redirect({ to: "/auth", search: { redirectTo }, throw: true });
    return panic("TanStack Router did not throw the sign-in redirect.");
  }

  if (!authContext.session.activeOrganizationId) {
    redirect({
      to: "/auth/organization",
      search: { redirectTo },
      replace: true,
      throw: true,
    });
    return panic("TanStack Router did not throw the organization redirect.");
  }

  const activeOrganizationId = authContext.session.activeOrganizationId;
  const userId = authContext.session.userId;

  // An account created where the professional-use statement was not shown
  // (agent provisioning, the operator command) accepts it here, on its first
  // interactive sign-in, before anything signed-in loads; the API refuses
  // its signed-in requests until then.
  const professionalUse = await ensureRouteQueryData(
    context.queryClient,
    professionalUseOptions(userId),
  );
  switch (professionalUse.status) {
    case PROFESSIONAL_USE_STATUS.accepted:
      break;
    case PROFESSIONAL_USE_STATUS.required:
      redirect({
        to: "/auth/professional-use",
        search: { redirectTo },
        replace: true,
        throw: true,
      });
      return panic(
        "TanStack Router did not throw the professional-use redirect.",
      );
    default:
      professionalUse satisfies never;
      return panic("Unhandled professional-use state");
  }

  // Start optional shell data immediately. The loader settles the role before
  // chrome mounts, while child loaders fetch their independent data in parallel.
  const onPrefetchError = (error: unknown) => {
    getAnalytics().captureError(error);
  };
  if (location.pathname === "/settings/organization/time-policy") {
    detached(
      (async () => {
        if (
          !(await isTimeBillingRouteEnabled(context.queryClient, {
            userId,
            organizationId: activeOrganizationId,
          }))
        ) {
          return;
        }
        await context.queryClient.query({
          ...organizationSettingsOptions({
            organizationId: activeOrganizationId,
            userId,
          }),
          staleTime: "static",
        });
      })(),
      "protected-layout.time-policy-prefetch",
    );
  }

  detached(
    prefetchRouteQuery(
      context.queryClient,
      aiAvailabilityOptions({ organizationId: activeOrganizationId }),
      onPrefetchError,
    ),
    "protected-layout.prefetch",
  );
  // Prefetched here so the bell's first page joins the shell's request wave
  // instead of chaining a new sequential round after hydration.
  if (isInboxPreviewEnabled()) {
    detached(
      prefetchNonCriticalInfiniteQuery(
        context.queryClient,
        notificationsOptions({
          organizationId: activeOrganizationId,
          userId: authContext.session.userId,
        }),
        onPrefetchError,
      ),
      "protected-layout.notifications-prefetch",
    );
  }

  return {
    user: {
      id: authContext.session.userId,
      activeOrganizationId,
      name: authContext.user.name || undefined,
      email: authContext.user.email,
      image: authContext.user.image,
      preferredName: authContext.user.preferredName,
      timezoneId: authContext.user.timezoneId,
      wordEditShortcut: authContext.user.wordEditShortcut,
    },
  };
};

/** `_protected`'s `loader`: settles the member role before chrome mounts. */
export const prefetchProtectedShell = async ({
  context,
}: {
  context: { queryClient: QueryClient };
}) =>
  await prefetchRouteQuery(context.queryClient, roleOptions, (error) => {
    getAnalytics().captureError(error);
  });
