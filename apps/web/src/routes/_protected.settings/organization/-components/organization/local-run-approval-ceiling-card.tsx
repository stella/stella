import { useId } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import {
  DESKTOP_RUNNER_APPROVAL_MODES,
  type DesktopRunnerApprovalMode,
} from "@stll/api-contract/desktop-runner";
import { Frame, FramePanel } from "@stll/ui/frame";
import { Label } from "@stll/ui/label";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";

import { LOCAL_RUN_PERMISSION_KEYS } from "@/components/chat/chat-run-target-menu.logic";
import { chatKeys } from "@/features/chat/chat-query-contract";
import { localRunnersOptions } from "@/features/chat/queries";
import { usePermissions } from "@/hooks/use-permissions";
import { api } from "@/lib/api";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { invokeAppOnlyWrite } from "@/lib/capabilities/capability-request";
import { detached } from "@/lib/detached";
import { unwrapApiResponse } from "@/lib/errors/api";
import { queryView } from "@/lib/query-view.logic";
import {
  organizationSettingsKeys,
  organizationSettingsOptions,
} from "@/queries/organization-settings";
import { useSettingsMutation } from "@/routes/_protected.settings/organization/-hooks/use-settings-mutation";

const isApprovalMode = (value: unknown): value is DesktopRunnerApprovalMode =>
  DESKTOP_RUNNER_APPROVAL_MODES.some((mode) => mode === value);

/**
 * The most a coding agent running a chat on a member's computer may do
 * without asking. Shown to an administrator who can run chats on a computer
 * themselves, as the feature is offered per person; the API holds every
 * member's turns to it either way.
 */
export const LocalRunApprovalCeilingCard = () => {
  const t = useTranslations();
  const selectId = useId();
  const queryClient = useQueryClient();
  const user = useAuthenticatedUser();
  const canEdit = usePermissions({ organizationSettings: ["update"] });
  const runnersView = queryView(
    useQuery(localRunnersOptions(user.activeOrganizationId)),
  );
  const settingsView = queryView(
    useQuery(
      organizationSettingsOptions({
        organizationId: user.activeOrganizationId,
        userId: user.id,
      }),
    ),
  );
  const mutation = useSettingsMutation({
    exceptionScope: {
      type: "handler",
      handlerId: "LocalRunApprovalCeilingCard.mutation.useSettingsMutation",
    },
    // An agent must not raise its own limit, so this write has no capability.
    mutationFn: async (maxApprovals: DesktopRunnerApprovalMode) =>
      await invokeAppOnlyWrite(
        "organization-settings.local-runs.update",
        async () =>
          unwrapApiResponse(
            await api["organization-settings"]["local-runs"].post({
              maxApprovals,
            }),
          ),
      ),
    invalidate: organizationSettingsKeys.all,
    // A save another administrator beat is refused; the stored ceiling is
    // read again so the selector shows it before the next choice.
    invalidateOn: "settled",
    onSuccess: () => {
      // The Run on menu reads the ceiling with the member's computers.
      detached(
        queryClient.invalidateQueries({
          queryKey: chatKeys.localRunners(user.activeOrganizationId),
        }),
        "local-run-approval-ceiling.invalidate-runners",
      );
    },
    successToast: { title: t("settings.organization.localRuns.updated") },
    errorToast: {
      title: t("errors.actionFailed"),
      description: t("common.somethingWentWrong"),
    },
  });

  if (
    runnersView.type !== "items" ||
    runnersView.items.status !== "enabled" ||
    settingsView.type !== "items"
  ) {
    return null;
  }
  const selected = settingsView.items.localRunMaxApprovalMode;

  return (
    <Frame>
      <FramePanel>
        <div className="flex flex-col gap-3 p-1">
          <Label className="text-sm font-medium" htmlFor={selectId}>
            {t("settings.organization.localRuns.title")}
          </Label>
          <p className="text-muted-foreground text-xs text-pretty">
            {t("settings.organization.localRuns.description")}
          </p>
          <Select
            disabled={!canEdit || mutation.isPending}
            onValueChange={(next) => {
              if (isApprovalMode(next) && next !== selected) {
                mutation.mutate(next);
              }
            }}
            value={selected}
          >
            <SelectTrigger className="w-56" id={selectId}>
              <SelectValue>
                {t(LOCAL_RUN_PERMISSION_KEYS[selected].label)}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {DESKTOP_RUNNER_APPROVAL_MODES.map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {t(LOCAL_RUN_PERMISSION_KEYS[mode].label)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <p className="text-muted-foreground text-2xs text-pretty">
            {t(LOCAL_RUN_PERMISSION_KEYS[selected].description)}
          </p>
        </div>
      </FramePanel>
    </Frame>
  );
};
