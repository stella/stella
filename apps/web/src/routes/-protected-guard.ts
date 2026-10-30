import type { QueryClient } from "@tanstack/react-query";
import { redirect } from "@tanstack/react-router";
import { panic } from "better-result";

import { isInboxPreviewEnabled } from "@/hooks/use-inbox-preview";
import { isTimeBillingRouteEnabled } from "@/hooks/use-time-billing-preview";
import { getAnalytics } from "@/lib/analytics/provider";
import { roleOptions } from "@/lib/auth-queries";
import { stashDesktopAccountLink } from "@/lib/desktop-bridge";
import { detached } from "@/lib/detached";
import { notificationsOptions } from "@/lib/notification-queries";
import { aiAvailabilityOptions } from "@/lib/organization/ai-config-queries";
import {
  prefetchNonCriticalInfiniteQuery,
  prefetchRouteQuery,
} from "@/lib/react-query";
import { returnPathOf } from "@/lib/redirect";
import { workspacesNavigationOptions } from "@/lib/workspaces/queries";
import { organizationSettingsOptions } from "@/queries/organization-settings";
import {
  loadAuthContext,
  requireProfessionalUseForSignedInRoute,
} from "@/routes/-auth-context";

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
  // Before any redirect drops the address-bar fragment.
  stashDesktopAccountLink();
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

  await requireProfessionalUseForSignedInRoute({
    authContext,
    queryClient: context.queryClient,
    location,
  });

  // Start optional shell data immediately. The loader settles the role before
  // chrome mounts, while child loaders fetch their independent data in parallel.
  const onPrefetchError = (error: unknown) => {
    getAnalytics().captureError(error, {
      fingerprintKey: "loadProtectedContext.onPrefetchError:failure",
      scope: {
        type: "handler",
        handlerId: "loadProtectedContext.onPrefetchError:failure",
      },
    });
  };
  if (location.pathname === "/admin/time-policy") {
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

  startSignedInShellRequests({
    queryClient: context.queryClient,
    organizationId: activeOrganizationId,
    userId,
  });
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
      readerAnswerLanguage: authContext.user.readerAnswerLanguage,
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
    getAnalytics().captureError(error, {
      fingerprintKey: "prefetchProtectedShell:failure",
      scope: { type: "handler", handlerId: "prefetchProtectedShell:failure" },
    });
  });

/**
 * Starts the shell data every signed-in page reads, in the guard's request
 * wave. Nothing here is awaited, so route commit never waits on it; chrome
 * later subscribes to the same keys and reads a warm cache.
 */
export const startSignedInShellRequests = ({
  queryClient,
  organizationId,
  userId,
}: {
  queryClient: QueryClient;
  organizationId: string;
  userId: string;
}): void => {
  const onPrefetchError = (error: unknown) => {
    getAnalytics().captureError(error, {
      fingerprintKey: "startSignedInShellRequests:onPrefetchError",
      scope: {
        type: "handler",
        handlerId: "startSignedInShellRequests:onPrefetchError",
      },
    });
  };
  detached(
    prefetchRouteQuery(
      queryClient,
      aiAvailabilityOptions({ organizationId }),
      onPrefetchError,
    ),
    "protected-layout.prefetch",
  );
  // The sidebar reads the workspace list on every signed-in page, and page
  // content waits on its server-owned feature enrolment (time billing) before
  // it asks for feature data. Started after chrome mounts, it opened its own
  // sequential round and pushed every enrolment-gated request one round later.
  detached(
    prefetchRouteQuery(
      queryClient,
      workspacesNavigationOptions({ userId, organizationId }),
      onPrefetchError,
    ),
    "protected-layout.navigation-prefetch",
  );
};
