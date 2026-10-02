import { lazy, Suspense } from "react";

import { usePermissions } from "@/hooks/use-permissions";
import { useTimeBillingPreviewEnabled } from "@/hooks/use-time-billing-preview";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";

const TimerContent = lazy(async () => {
  const { GlobalTimerContent } =
    await import("@/features/time-timers/global-timer-content");
  return { default: GlobalTimerContent };
});

export const GlobalTimer = ({ workspaceId }: { workspaceId?: string }) => {
  const enabled = useTimeBillingPreviewEnabled();
  const canRead = usePermissions({ timeEntry: ["read"] });
  const user = useAuthenticatedUser();
  if (!enabled || !canRead) {
    return null;
  }
  return (
    <Suspense fallback={null}>
      <TimerContent
        key={`${user.activeOrganizationId}:${user.id}`}
        {...(workspaceId === undefined ? {} : { workspaceId })}
      />
    </Suspense>
  );
};
