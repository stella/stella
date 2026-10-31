import { useId } from "react";

import { useQuery } from "@tanstack/react-query";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Frame, FramePanel } from "@stll/ui/frame";
import { Label } from "@stll/ui/label";

import { usePermissions } from "@/hooks/use-permissions";
import { api } from "@/lib/api";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { detached } from "@/lib/detached";
import { unwrapApiResponse } from "@/lib/errors/api";
import { queryView } from "@/lib/query-view.logic";
import { TimeZonePicker } from "@/lib/time-zone-picker";
import {
  organizationSettingsKeys,
  organizationSettingsOptions,
} from "@/queries/organization-settings";
import {
  FOLLOW_JURISDICTION,
  timeZonePickerValue,
  timeZoneToSave,
} from "@/routes/_protected.admin/-components/organization/time-zone-card.logic";
import { useSettingsMutation } from "@/routes/_protected.admin/-hooks/use-settings-mutation";

export const OrganizationTimeZoneCard = () => {
  const t = useTranslations();
  const selectId = useId();
  const user = useAuthenticatedUser();
  const canEdit = usePermissions({ organizationSettings: ["update"] });
  const view = queryView(
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
      handlerId: "OrganizationTimeZoneCard.mutation.useSettingsMutation",
    },
    mutationFn: async (timeZone: string | null) =>
      unwrapApiResponse(await api["organization-settings"].post({ timeZone })),
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
          <TimeZonePicker
            id={selectId}
            label={t("settings.organization.timeZone.title")}
            disabled={!canEdit || mutation.isPending}
            jurisdictionCountries={settings.practiceJurisdictions.map(
              ({ countryCode }) => countryCode,
            )}
            follow={{
              value: FOLLOW_JURISDICTION,
              zone: settings.primaryJurisdictionTimeZone,
              label: t("settings.organization.timeZone.followingJurisdiction", {
                timeZone: settings.primaryJurisdictionTimeZone.replace(
                  /_/gu,
                  " ",
                ),
              }),
            }}
            onValueChange={(next) => {
              if (next !== selected) {
                mutation.mutate(timeZoneToSave(next));
              }
            }}
            value={selected}
          />
        </div>
      </FramePanel>
    </Frame>
  );
};
