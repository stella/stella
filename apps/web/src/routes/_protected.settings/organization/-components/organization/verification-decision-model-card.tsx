import { useId } from "react";

import { useTranslations } from "use-intl";

import { Frame, FramePanel } from "@stll/ui/frame";
import { Label } from "@stll/ui/label";
import { Switch } from "@stll/ui/switch";

import { usePermissions } from "@/hooks/use-permissions";
import { api } from "@/lib/api";
import { unwrapApiResponse } from "@/lib/errors/api";
import { aiConfigKeys } from "@/lib/organization/ai-config-queries";
import type { OrganizationAIConfig } from "@/lib/organization/ai-config-queries";
import { useSettingsMutation } from "@/routes/_protected.settings/organization/-hooks/use-settings-mutation";

import { verificationDecisionModelSwitch } from "./verification-decision-model.logic";

type VerificationDecisionModelCardProps = {
  setting: OrganizationAIConfig["verificationDecisionModel"];
};

/**
 * Whether Anchor Verification asks the decision model for each claim's
 * verdict. Saved as soon as it is flipped. It can be turned on only when the
 * organization has a decision model it can reach; one that was on stays
 * switchable off after its model is gone.
 */
export const VerificationDecisionModelCard = ({
  setting,
}: VerificationDecisionModelCardProps) => {
  const t = useTranslations();
  const canEdit = usePermissions({ organizationSettings: ["update"] });
  const mutation = useSettingsMutation({
    exceptionScope: {
      type: "handler",
      handlerId: "VerificationDecisionModelCard.mutation.useSettingsMutation",
    },
    mutationFn: async (enabled: boolean) =>
      unwrapApiResponse(
        await api["organization-settings"]["verification-decision-model"].post({
          enabled,
        }),
      ),
    invalidate: aiConfigKeys.all,
    // A refused or raced save reads the stored setting again.
    invalidateOn: "settled",
    successToast: {
      title: t("settings.organization.verificationDecisionModel.updated"),
    },
    errorToast: {
      title: t("errors.actionFailed"),
      description: t("common.somethingWentWrong"),
    },
  });
  return (
    <VerificationDecisionModelControl
      setting={setting}
      canEdit={canEdit}
      pending={mutation.isPending}
      onChange={(enabled) => mutation.mutate(enabled)}
    />
  );
};

type VerificationDecisionModelControlProps =
  VerificationDecisionModelCardProps & {
    canEdit: boolean;
    pending: boolean;
    onChange: (enabled: boolean) => void;
  };

/** The switch with its title, description and why it cannot be turned on. */
export const VerificationDecisionModelControl = ({
  setting,
  canEdit,
  pending,
  onChange,
}: VerificationDecisionModelControlProps) => {
  const t = useTranslations();
  const switchId = useId();
  const view = verificationDecisionModelSwitch({ setting, canEdit, pending });
  return (
    <Frame>
      <FramePanel>
        <div className="flex flex-col gap-3 p-1">
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 flex-col gap-1">
              <Label className="text-sm font-medium" htmlFor={switchId}>
                {t("settings.organization.verificationDecisionModel.title")}
              </Label>
              <p className="text-muted-foreground text-xs text-pretty">
                {t(
                  "settings.organization.verificationDecisionModel.description",
                )}
              </p>
            </div>
            <Switch
              id={switchId}
              checked={view.checked}
              disabled={view.disabled}
              onCheckedChange={onChange}
            />
          </div>
          {view.unavailable && (
            <p className="text-muted-foreground text-2xs text-pretty">
              {t("settings.organization.verificationDecisionModel.unavailable")}
            </p>
          )}
        </div>
      </FramePanel>
    </Frame>
  );
};
