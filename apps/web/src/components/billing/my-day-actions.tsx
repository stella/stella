import { useState } from "react";

import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

import { AbsenceDialog } from "@/components/billing/absence-dialog";
import { GlobalTimerConfirmation } from "@/components/billing/global-timer-confirmation";
import { usePermissions } from "@/hooks/use-permissions";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { useQuickEntryStore } from "@/lib/workspaces/quick-entry-store";

export const MyDayActions = ({ date }: { date: string }) => {
  const t = useTranslations();
  const user = useAuthenticatedUser();
  const canCreate = usePermissions({ timeEntry: ["create"] });
  const openQuickEntry = useQuickEntryStore((state) => state.openDialog);
  const [absenceOpen, setAbsenceOpen] = useState(false);

  return (
    <div className="flex flex-wrap items-center gap-2">
      {canCreate && (
        <Button
          size="sm"
          onClick={() =>
            openQuickEntry({
              userId: user.id,
              organizationId: user.activeOrganizationId,
            })
          }
        >
          {t("common.logTime")}
        </Button>
      )}
      <GlobalTimerConfirmation />
      <Button size="sm" variant="outline" onClick={() => setAbsenceOpen(true)}>
        {t("billing.absences.title")}
      </Button>
      <AbsenceDialog
        open={absenceOpen}
        onOpenChange={setAbsenceOpen}
        initialDate={date}
      />
    </div>
  );
};
