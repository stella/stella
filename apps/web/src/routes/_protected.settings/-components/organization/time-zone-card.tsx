import { useId } from "react";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { Frame, FramePanel } from "@stll/ui/frame";
import { Label } from "@stll/ui/label";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";

import { usePermissions } from "@/hooks/use-permissions";
import { api } from "@/lib/api";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { unwrapEden } from "@/lib/errors/api";
import { COMMON_TIMEZONES } from "@/lib/timezones";
import {
  organizationSettingsKeys,
  organizationSettingsOptions,
} from "@/queries/organization-settings";
import { useSettingsMutation } from "@/routes/_protected.settings/-hooks/use-settings-mutation";

/** The curated zones, plus the organization's own when it is not one of them. */
const zoneOptions = (current: string): readonly string[] => {
  const common: readonly string[] = COMMON_TIMEZONES;
  return common.includes(current) ? common : [current, ...common];
};

export const OrganizationTimeZoneCard = () => {
  const t = useTranslations();
  const selectId = useId();
  const activeOrganizationId = useAuthenticatedUser().activeOrganizationId;
  const canEdit = usePermissions({ organizationSettings: ["update"] });
  const { data: settings } = useQuery(
    organizationSettingsOptions(activeOrganizationId),
  );

  const mutation = useSettingsMutation({
    mutationFn: async (timeZone: string) =>
      unwrapEden(await api["organization-settings"].post({ timeZone })),
    invalidate: organizationSettingsKeys.all,
    successToast: { title: t("settings.organization.timeZone.updated") },
    errorToast: { title: t("errors.actionFailed") },
  });

  if (!settings) {
    return null;
  }

  return (
    <Frame>
      <FramePanel>
        <div className="flex flex-col gap-3 p-1">
          <p className="text-muted-foreground text-sm">
            {t("settings.organization.timeZone.description")}
          </p>
          <Label className="sr-only" htmlFor={selectId}>
            {t("settings.organization.timeZone.title")}
          </Label>
          <Select
            disabled={!canEdit || mutation.isPending}
            onValueChange={(next) => {
              if (!next || next === settings.timeZone) {
                return;
              }
              mutation.mutate(next);
            }}
            value={settings.timeZone}
          >
            <SelectTrigger className="w-72" id={selectId}>
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {zoneOptions(settings.timeZone).map((zone) => (
                <SelectItem key={zone} value={zone}>
                  {zone.replace(/_/gu, " ")}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      </FramePanel>
    </Frame>
  );
};
