import { lazy, Suspense } from "react";

import { usePermissions } from "@/hooks/use-permissions";
import { useTimeBillingPreviewEnabled } from "@/hooks/use-time-billing-preview";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { useEffectiveHotkey } from "@/lib/use-effective-shortcuts";
import { useQuickEntryStore } from "@/lib/workspaces/quick-entry-store";
import { useQuickEntryHotkey } from "@/lib/workspaces/use-quick-entry-hotkey";

const QuickEntryDialog = lazy(() => import("@/components/quick-entry-dialog"));

export const QuickEntry = () => {
  const user = useAuthenticatedUser();
  const preview = useTimeBillingPreviewEnabled();
  const canCreate = usePermissions({ timeEntry: ["create"] });
  const dialog = useQuickEntryStore((state) => state.dialog);
  useQuickEntryHotkey({
    enabled: preview && canCreate,
    hotkey: useEffectiveHotkey("logTime"),
    scope: { userId: user.id, organizationId: user.activeOrganizationId },
  });

  if (
    !preview ||
    !canCreate ||
    dialog.status !== "open" ||
    dialog.userId !== user.id ||
    dialog.organizationId !== user.activeOrganizationId
  ) {
    return null;
  }
  return (
    <Suspense>
      <QuickEntryDialog key={`${user.id}:${user.activeOrganizationId}`} />
    </Suspense>
  );
};
