import { createFileRoute, redirect } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Skeleton } from "@stll/ui/components/skeleton";

import { getAnalytics } from "@/lib/analytics/provider";
import { authClient } from "@/lib/auth";
import {
  ensureRouteInfiniteQueryData,
  ensureRouteQueryData,
} from "@/lib/react-query";
import { roleOptions } from "@/routes/-queries";
import { MemoryPanel } from "@/routes/_protected.settings/-components/organization/memory/memory-panel";
import { SettingsPageHeader } from "@/routes/_protected.settings/-components/settings-page-header";
import { memoriesOptions } from "@/routes/_protected.settings/-queries/memories";

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
  // The panel opens on the "mine" tab, which reads two different slices of
  // /memories: the suggestions queue (status=suggested) and the list below it
  // (status=active). They are separate cursors over separate result sets, so
  // they cannot collapse into one request — but both would otherwise start on
  // component mount, after the route has already resolved. Priming them here
  // starts both during route load instead.
  loader: async ({ context }) => {
    await Promise.all(
      MEMORY_TAB_PRIMED_STATUSES.map(async (status) => {
        // Priming is best-effort: the panel renders its own error state with a
        // retry, so a failed prefetch must not take the whole route down.
        try {
          await ensureRouteInfiniteQueryData(
            context.queryClient,
            memoriesOptions({
              activeOrganizationId: context.activeOrganizationId,
              scope: "user",
              status,
            }),
          );
        } catch (error: unknown) {
          getAnalytics().captureError(error);
        }
      }),
    );
  },
  component: MemoryPage,
  pendingComponent: MemoryPagePending,
});

// Must match the default tab/view in MemoryPanel; priming anything else would
// warm a cache entry the first paint never reads.
const MEMORY_TAB_PRIMED_STATUSES = ["suggested", "active"] as const;

const MEMORY_TAB_SKELETON_KEYS = ["mine", "firm", "matter"] as const;
const MEMORY_ROW_SKELETON_KEYS = ["primary", "secondary", "tertiary"] as const;

function MemoryPagePending() {
  return (
    <>
      <header className="flex flex-col gap-1">
        <Skeleton className="h-7 w-24" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </header>

      <section className="flex flex-col gap-2">
        <div className="bg-muted flex w-fit items-center gap-0.5 rounded-lg p-0.5">
          {MEMORY_TAB_SKELETON_KEYS.map((key) => (
            <Skeleton className="h-8 w-24 rounded-md" key={key} />
          ))}
        </div>

        <div className="flex flex-col gap-6 pt-4">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-16 w-full rounded-lg" />
          </div>

          <div className="flex flex-col gap-2">
            <Skeleton className="h-20 w-full rounded-md" />
            <div className="flex justify-end">
              <Skeleton className="h-9 w-24 rounded-md" />
            </div>
          </div>

          <div className="flex flex-col gap-2">
            {MEMORY_ROW_SKELETON_KEYS.map((key) => (
              <Skeleton className="h-24 w-full rounded-lg" key={key} />
            ))}
          </div>
        </div>
      </section>
    </>
  );
}

function MemoryPage() {
  const t = useTranslations("memory");

  return (
    <>
      <SettingsPageHeader
        description={t("pageDescription")}
        title={t("pageTitle")}
      />
      <MemoryPanel />
    </>
  );
}
