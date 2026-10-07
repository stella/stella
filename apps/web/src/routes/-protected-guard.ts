import type { QueryClient } from "@tanstack/react-query";
import { redirect } from "@tanstack/react-router";
import { panic } from "better-result";

import { isInboxPreviewEnabled } from "@/hooks/use-inbox-preview";
import { isTimeBillingRouteEnabled } from "@/hooks/use-time-billing-preview";
import { getAnalytics } from "@/lib/analytics/provider";
import { roleOptions } from "@/lib/auth-queries";
import { detached } from "@/lib/detached";
import { notificationsOptions } from "@/lib/notification-queries";
import { aiAvailabilityOptions } from "@/lib/organization/ai-config-queries";
import {
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
 * `_protected`'s `beforeLoad`: sends a visitor without a session to sign in
 * and one without an organization to pick one, starts the shell's optional
 * data, and returns the signed-in user as route context.
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
  context: { queryClient: QueryClient } & Awaited<
    ReturnType<typeof loadProtectedContext>
  >;
}) =>
  await Promise.all([
    prefetchRouteQuery(context.queryClient, roleOptions, (error) => {
      getAnalytics().captureError(error);
    }),
    prefetchRouteQuery(
      context.queryClient,
      organizationSettingsOptions({
        organizationId: context.user.activeOrganizationId,
        userId: context.user.id,
      }),
      (error) => {
        getAnalytics().captureError(error);
      },
    ),
  ]);
