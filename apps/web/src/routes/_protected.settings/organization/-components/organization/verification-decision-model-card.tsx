import { useId } from "react";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { Frame, FramePanel } from "@stll/ui/frame";
import { Label } from "@stll/ui/label";
import { Switch } from "@stll/ui/switch";
import { stellaToast } from "@stll/ui/toast";

import { usePermissions } from "@/hooks/use-permissions";
import { api } from "@/lib/api";
import { invokeAppOnlyWrite } from "@/lib/capabilities/capability-request";
import { unwrapApiResponse } from "@/lib/errors/api";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { notifyUserError } from "@/lib/errors/user-toast";
import type { OrganizationAIConfig } from "@/lib/organization/ai-config-queries";
import { resourceMutation } from "@/lib/workspace-realtime";

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
  const queryClient = useQueryClient();
  const mutation = useMutation({
    // Saves reach the server in the order they were flipped.
    scope: { id: "settings:verification-decision-model" },
    // A committed save refreshes the AI configuration read through the
    // contract, so the switch shows what was stored.
    mutationFn: resourceMutation({
      mutation: "updateVerificationDecisionModel",
      queryClient,
      scope: { type: "organization" },
      // The organization's AI policy is an administrator's click, never an
      // agent's, so this write has no capability.
      mutationFn: async (enabled: boolean) =>
        await invokeAppOnlyWrite(
          "organization-settings.verification-decision-model.update",
          async () =>
            unwrapApiResponse(
              await api["organization-settings"][
                "verification-decision-model"
              ].post({
                enabled,
              }),
            ),
        ),
    }),
    onSuccess: () => {
      stellaToast.add({
        title: t("settings.organization.verificationDecisionModel.updated"),
        type: "success",
      });
    },
    onError: (error) => {
      notifyUserError(error, t("errors.actionFailed"), {
        description: userErrorFromThrown(error, t("common.somethingWentWrong")),
      });
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
