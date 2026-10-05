import { useId } from "react";

import { useQuery } from "@tanstack/react-query";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
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
import { detached } from "@/lib/detached";
import { unwrapEden } from "@/lib/errors/api";
import { COMMON_TIMEZONES } from "@/lib/timezones";
import { useQueryView } from "@/lib/use-query-view";
import {
  organizationSettingsKeys,
  organizationSettingsOptions,
} from "@/queries/organization-settings";
import {
  FOLLOW_JURISDICTION,
  timeZonePickerValue,
  timeZoneToSave,
} from "@/routes/_protected.settings/-components/organization/time-zone-card.logic";
import { useSettingsMutation } from "@/routes/_protected.settings/-hooks/use-settings-mutation";

/** The curated zones, plus the organization's own when it is not one of them. */
const zoneOptions = (current: string): readonly string[] => {
  const common: readonly string[] = COMMON_TIMEZONES;
  return common.includes(current) ? common : [current, ...common];
};

export const OrganizationTimeZoneCard = () => {
  const t = useTranslations();
  const selectId = useId();
  const user = useAuthenticatedUser();
  const canEdit = usePermissions({ organizationSettings: ["update"] });
  const view = useQueryView(
    useQuery(
      organizationSettingsOptions({
        organizationId: user.activeOrganizationId,
        userId: user.id,
      }),
    ),
  );

  const mutation = useSettingsMutation({
    mutationFn: async (timeZone: string | null) =>
      unwrapEden(await api["organization-settings"].post({ timeZone })),
    invalidate: organizationSettingsKeys.all,
    successToast: { title: t("settings.organization.timeZone.updated") },
    errorToast: { title: t("errors.actionFailed") },
  });

  switch (view.type) {
    case "pending":
    case "empty":
      return null;
    case "error":
      return (
        <Frame>
          <FramePanel>
            <p className="text-muted-foreground text-sm">
              {t("errors.actionFailed")}
            </p>
            <Button
              className="mt-3"
              onClick={() => {
                detached(view.retry(), "organization-time-zone.refetch");
              }}
              variant="ghost"
            >
              {t("common.retry")}
            </Button>
          </FramePanel>
        </Frame>
      );
    case "items":
      break;
    default:
      view satisfies never;
      return panic("Unhandled organization settings query state");
  }
  const settings = view.items;
  const selected = timeZonePickerValue(settings);

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
              if (!next || next === selected) {
                return;
              }
              mutation.mutate(timeZoneToSave(next));
            }}
            value={selected}
          >
            <SelectTrigger className="w-72" id={selectId}>
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value={FOLLOW_JURISDICTION}>
                {selected === FOLLOW_JURISDICTION
                  ? t("settings.organization.timeZone.followingJurisdiction", {
                      timeZone: settings.timeZone.replace(/_/gu, " "),
                    })
                  : t("settings.organization.timeZone.followJurisdiction")}
              </SelectItem>
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
