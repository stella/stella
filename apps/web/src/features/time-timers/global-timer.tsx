import { lazy, Suspense } from "react";
import type { ComponentType } from "react";

import { useInfiniteQuery } from "@tanstack/react-query";

import { timeTimersOptions } from "@/features/time-timers/queries";
import { useHasMounted } from "@/hooks/use-chrome-query";
import { usePermissions } from "@/hooks/use-permissions";
import { useTimeBillingPreviewEnabled } from "@/hooks/use-time-billing-preview";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";

const TimerContent = lazy(async () => {
  const { GlobalTimerContent } =
    await import("@/features/time-timers/global-timer-content");
  return { default: GlobalTimerContent };
});

export const GlobalTimer = ({
  workspaceId,
  Content = TimerContent,
}: {
  workspaceId?: string;
  /** The timer surface; tests pass a fake to observe the wrapper alone. */
  Content?: ComponentType<{ workspaceId?: string }>;
}) => {
  const enabled = useTimeBillingPreviewEnabled();
  const canRead = usePermissions({ timeEntry: ["read"] });
  const user = useAuthenticatedUser();
  // Start the timers request with the flag, not after the lazy chunk loads:
  // waiting for the chunk adds a sequential network round to every page.
  // Chrome fetches still wait for mount (see useChromeQuery).
  const mounted = useHasMounted();
  useInfiniteQuery({
    ...timeTimersOptions(user.activeOrganizationId, user.id),
    enabled: mounted && enabled && canRead,
  });
  if (!enabled || !canRead) {
    return null;
  }
  return (
    <Suspense fallback={null}>
      <Content
        key={`${user.activeOrganizationId}:${user.id}`}
        {...(workspaceId === undefined ? {} : { workspaceId })}
      />
    </Suspense>
  );
};
