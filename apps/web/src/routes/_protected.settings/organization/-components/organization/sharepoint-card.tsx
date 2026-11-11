import { useId, useState } from "react";

import { useTranslations } from "use-intl";

import { DestructiveConfirmDialog } from "@stll/ui/destructive-confirm-dialog";
import { Frame, FramePanel } from "@stll/ui/frame";
import { Label } from "@stll/ui/label";
import { Switch } from "@stll/ui/switch";

import { SHAREPOINT_ACCESS } from "@/features/sharepoint/sharepoint-access.logic";
import { useSharepointAccess } from "@/features/sharepoint/sharepoint-hooks";
import { sharepointKeys } from "@/features/sharepoint/sharepoint-queries";
import { usePermissions } from "@/hooks/use-permissions";
import { api } from "@/lib/api";
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
  const access = useSharepointAccess();
  if (access === null || access.type === SHAREPOINT_ACCESS.unavailable) {
    return null;
  }
  return (
    <SharepointEnablement enabled={access.type === SHAREPOINT_ACCESS.enabled} />
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
      unwrapApiResponse(await api.sharepoint.enablement.put({ enabled: next })),
    invalidate: sharepointKeys.root(),
    errorToast: { title: t("errors.actionFailed") },
  });

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
        onConfirm={async () => await mutation.mutateAsync(false)}
        onOpenChange={setConfirmingDisable}
        open={confirmingDisable}
        title={t("sharepoint.admin.disableTitle")}
      />
    </section>
  );
};
