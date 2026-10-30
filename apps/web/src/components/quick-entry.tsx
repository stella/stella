import { lazy, Suspense } from "react";

import { usePermissions } from "@/hooks/use-permissions";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { useAvailableHotkey } from "@/lib/use-effective-shortcuts";
import { useQuickEntryStore } from "@/lib/workspaces/quick-entry-store";
import { useQuickEntryHotkey } from "@/lib/workspaces/use-quick-entry-hotkey";

const QuickEntryDialog = lazy(
  async () => import("@/components/quick-entry-dialog"),
);

export const QuickEntry = () => {
  const user = useAuthenticatedUser();
  const canCreate = usePermissions({ timeEntry: ["create"] });
  const hotkey = useAvailableHotkey("logTime");
  const dialog = useQuickEntryStore((state) => state.dialog);
  useQuickEntryHotkey({
    enabled: hotkey !== undefined && canCreate,
    hotkey: hotkey ?? "Mod+Alt+T",
    scope: { userId: user.id, organizationId: user.activeOrganizationId },
  });

  if (
    hotkey === undefined ||
    !canCreate ||
    dialog.status === "closed" ||
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
