import { lazy, Suspense } from "react";
import type { ComponentType } from "react";

import { useInfiniteQuery } from "@tanstack/react-query";

import { ClockIcon } from "@stll/ui/icons";

import { timeTimersOptions } from "@/features/time-timers/queries";
import { useHasMounted } from "@/hooks/use-chrome-query";
import { usePermissions } from "@/hooks/use-permissions";
import { useTimeBillingDecision } from "@/hooks/use-time-billing-preview";
import { useTimeChromeVisible } from "@/hooks/use-time-chrome-visible";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";

const TimerContent = lazy(async () => {
  const { GlobalTimerContent } =
    await import("@/features/time-timers/global-timer-content");
  return { default: GlobalTimerContent };
});

/** Holds the trigger's place while its chunk loads, so the header stays put. */
const TimerTriggerPlaceholder = () => (
  <span aria-hidden className="inline-flex min-h-11 items-center px-3">
    <ClockIcon className="size-4" />
  </span>
);

export const GlobalTimer = ({
  workspaceId,
  Content = TimerContent,
}: {
  workspaceId?: string;
  /** The timer surface; tests pass a fake to observe the wrapper alone. */
  Content?: ComponentType<{ workspaceId?: string }>;
}) => {
  const visible = useTimeChromeVisible();
  const decision = useTimeBillingDecision();
  const canRead = usePermissions({ timeEntry: ["read"] });
  const ready = decision === true && canRead;
  const user = useAuthenticatedUser();
  // Start the timers request with the flag, not after the lazy chunk loads:
  // waiting for the chunk adds a sequential network round to every page.
  // Chrome fetches still wait for mount (see useChromeQuery).
  const mounted = useHasMounted();
  useInfiniteQuery({
    ...timeTimersOptions(user.activeOrganizationId, user.id),
    enabled: mounted && ready,
  });
  if (!visible) {
    return null;
  }
  if (!ready) {
    return <TimerTriggerPlaceholder />;
  }
  return (
    <Suspense fallback={<TimerTriggerPlaceholder />}>
      <Content
        key={`${user.activeOrganizationId}:${user.id}`}
        {...(workspaceId === undefined ? {} : { workspaceId })}
      />
    </Suspense>
  );
};
