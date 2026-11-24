import { createFileRoute, redirect } from "@tanstack/react-router";
import { Result } from "better-result";

import { getAnalytics } from "@/lib/analytics/provider";
import { authClient } from "@/lib/auth-client";
import { roleOptions } from "@/lib/auth-queries";
import { loadCallerFeature } from "@/lib/organization/feature-access/access";
import { CALLER_FEATURE } from "@/lib/organization/feature-access/surfaces";
import { pageTitle } from "@/lib/page-title";
import {
  ensureRouteInfiniteQueryData,
  ensureRouteQueryData,
} from "@/lib/react-query";
import { routePresentation } from "@/routes/-route-presentation";
import { memoriesOptions } from "@/routes/_protected.settings/-queries/memories";

import { MemoryPage } from "./-account.memory.page";
import { MemoryPending } from "./-account.memory.pending";

export const Route = createFileRoute("/_protected/settings/account/memory")({
  beforeLoad: async ({ context }) => {
    const role = await ensureRouteQueryData(context.queryClient, roleOptions);
    const canUseMemory = authClient.organization.checkRolePermission({
      role,
      permissions: { chat: ["create"] },
    });

    if (!canUseMemory) {
      throw redirect({ to: "/settings/account/profile", replace: true });
    }

    return { activeOrganizationId: context.user.activeOrganizationId };
  },
  staticData: {
    presentation: routePresentation({
      type: "label",
      labelKey: "memory.pageTitle",
      to: "/settings/account/memory",
    }),
  },
  loader: async ({ context }) => {
    const admission = await loadCallerFeature({
      queryClient: context.queryClient,
      principal: {
        organizationId: context.user.activeOrganizationId,
        userId: context.user.id,
      },
      feature: CALLER_FEATURE.aiMemory,
      load: async () => {
        await Promise.all(
          MEMORY_TAB_PRIMED_STATUSES.map(async (status) => {
            // Priming is best-effort: the panel renders its own retry state.
            try {
              await ensureRouteInfiniteQueryData(
                context.queryClient,
                memoriesOptions({
                  activeOrganizationId: context.user.activeOrganizationId,
                  scope: "user",
                  status,
                  userId: context.user.id,
                }),
              );
            } catch (error: unknown) {
              getAnalytics().captureError(error, {
                fingerprintKey: "settings.account.memory.loader:failure",
                scope: {
                  type: "request",
                  method: "GET",
                  routeTemplate: "/_protected/settings/account/memory",
                },
              });
            }
          }),
        );
      },
    });
    if (Result.isError(admission)) {
      throw redirect({ to: "/settings/account/profile", replace: true });
    }
  },
  head: () => ({ meta: [{ title: pageTitle("memory.pageTitle") }] }),
  component: MemoryPage,
  pendingComponent: MemoryPending,
});

// Must match the default tab/view in MemoryPanel; the two statuses are
// independent cursors, so both must be warm for the first paint.
const MEMORY_TAB_PRIMED_STATUSES = ["suggested", "active"] as const;
