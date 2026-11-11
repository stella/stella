import { useId, useState } from "react";

import { useTranslations } from "use-intl";

import { DestructiveConfirmDialog } from "@stll/ui/destructive-confirm-dialog";
import { Frame, FramePanel } from "@stll/ui/frame";
import { Label } from "@stll/ui/label";
import { Switch } from "@stll/ui/switch";

import { QueryViewFeedback } from "@/components/query-view-feedback";
import { SHAREPOINT_ACCESS } from "@/features/sharepoint/sharepoint-access.logic";
import { useSharepointAccess } from "@/features/sharepoint/sharepoint-hooks";
import { sharepointKeys } from "@/features/sharepoint/sharepoint-queries";
import { usePermissions } from "@/hooks/use-permissions";
import { api } from "@/lib/api";
import { invokeAppOnlyWrite } from "@/lib/capabilities/capability-request";
import { unwrapApiResponse } from "@/lib/errors/api";
import { useSettingsMutation } from "@/routes/_protected.settings/organization/-hooks/use-settings-mutation";

/** The product name typed to confirm turning SharePoint off. */
const DISABLE_CONFIRMATION = "SharePoint";

/**
 * The organization's opt-in for SharePoint and OneDrive. Shown only where the
 * deployment offers SharePoint; turning it off removes every member's stored
 * Microsoft sign-in.
 */
export const SharepointCard = () => {
  const t = useTranslations();
  const access = useSharepointAccess();
  if (access.type === "error") {
    // The admin expects the switch here: say the read failed and offer a
    // retry instead of letting the section vanish.
    return (
      <section className="flex flex-col gap-3">
        <h2 className="text-base font-semibold">{t("sharepoint.title")}</h2>
        <Frame>
          <FramePanel>
            <QueryViewFeedback view={access} />
          </FramePanel>
        </Frame>
      </section>
    );
  }
  if (
    access.type !== "items" ||
    access.items.type === SHAREPOINT_ACCESS.unavailable
  ) {
    return null;
  }
  return (
    <SharepointEnablement
      enabled={access.items.type === SHAREPOINT_ACCESS.enabled}
    />
  );
};

const SharepointEnablement = ({ enabled }: { enabled: boolean }) => {
  const t = useTranslations();
  const switchId = useId();
  const canEdit = usePermissions({ organizationSettings: ["update"] });
  const [confirmingDisable, setConfirmingDisable] = useState(false);
  const mutation = useSettingsMutation({
    exceptionScope: {
      type: "handler",
      handlerId: "SharepointEnablement.update:failure",
    },
    mutationFn: async (next: boolean) =>
      await invokeAppOnlyWrite("sharepoint.enablement.update", async () =>
        unwrapApiResponse(
          await api.sharepoint.enablement.put({ enabled: next }),
        ),
      ),
    invalidate: sharepointKeys.root(),
    errorToast: { title: t("errors.actionFailed") },
  });
  // The dialog awaits this and stays open when the write fails.
  const confirmDisable = async () => await mutation.mutateAsync(false);

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-base font-semibold">{t("sharepoint.title")}</h2>
      <Frame>
        <FramePanel>
          <div className="flex items-start justify-between gap-4 p-1">
            <div className="flex min-w-0 flex-col gap-1">
              <Label className="text-sm font-medium" htmlFor={switchId}>
                {t("sharepoint.admin.toggleLabel")}
              </Label>
              <p className="text-muted-foreground text-xs text-pretty">
                {t("sharepoint.admin.description")}
              </p>
            </div>
            <Switch
              checked={enabled}
              disabled={!canEdit || mutation.isPending}
              id={switchId}
              onCheckedChange={(next) => {
                if (next) {
                  mutation.mutate(true);
                } else {
                  setConfirmingDisable(true);
                }
              }}
            />
          </div>
        </FramePanel>
      </Frame>
      <DestructiveConfirmDialog
        cancelLabel={t("common.cancel")}
        confirmLabel={t("sharepoint.admin.disableConfirm")}
        confirmation={DISABLE_CONFIRMATION}
        description={t("sharepoint.admin.disableDescription")}
        inputLabel={t("sharepoint.admin.disableInputLabel", {
          confirmation: DISABLE_CONFIRMATION,
        })}
        loading={mutation.isPending}
        onConfirm={confirmDisable}
        onOpenChange={setConfirmingDisable}
        open={confirmingDisable}
        title={t("sharepoint.admin.disableTitle")}
      />
    </section>
  );
};
