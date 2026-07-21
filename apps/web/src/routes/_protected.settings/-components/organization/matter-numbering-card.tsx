import { useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { useDebounce } from "use-debounce";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { Field, FieldLabel } from "@stll/ui/components/field";
import { Frame, FramePanel } from "@stll/ui/components/frame";
import { Input } from "@stll/ui/components/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/components/select";

import {
  organizationSettingsKeys,
  organizationSettingsOptions,
} from "@/features/organization-settings/organization-settings-queries";
import { api } from "@/lib/api";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { unwrapEden } from "@/lib/errors/api";
import { useSettingsMutation } from "@/routes/_protected.settings/-hooks/use-settings-mutation";

const PATTERN_PRESETS = [
  { value: "{SEQ}", key: "sequential" as const },
  { value: "{YYYY}/{SEQ}", key: "yearSequential" as const },
  {
    value: "{YYYY}-{MM}/{SEQ}",
    key: "yearMonthSequential" as const,
  },
] as const;

const PADDING_OPTIONS = [2, 3, 4, 5, 6] as const;

export const MatterNumberingCard = () => {
  const activeOrganizationId = useAuthenticatedUser().activeOrganizationId;
  const { data: settings } = useQuery(
    organizationSettingsOptions(activeOrganizationId),
  );

  if (!settings) {
    return null;
  }

  return (
    <MatterNumberingCardBody
      key={`${settings.matterNumberPattern}|${settings.matterNumberPadding}`}
      settings={settings}
    />
  );
};

type MatterNumberingSettings = {
  matterNumberPattern: string;
  matterNumberPadding: number;
};

const MatterNumberingCardBody = ({
  settings,
}: {
  settings: MatterNumberingSettings;
}) => {
  const t = useTranslations();
  const activeOrganizationId = useAuthenticatedUser().activeOrganizationId;

  const [pattern, setPattern] = useState(settings.matterNumberPattern);
  const [padding, setPadding] = useState(settings.matterNumberPadding);
  const [isCustom, setIsCustom] = useState(
    () =>
      !PATTERN_PRESETS.some(
        (preset) => preset.value === settings.matterNumberPattern,
      ),
  );
  const [debouncedPattern] = useDebounce(pattern, 300);
  const [debouncedPadding] = useDebounce(padding, 300);
  const { data: previewData } = useQuery({
    queryKey: [
      ...organizationSettingsKeys.byOrganization(activeOrganizationId),
      "matter-number-preview",
      debouncedPattern,
      debouncedPadding,
    ],
    queryFn: async ({ signal }) =>
      unwrapEden(
        await api["organization-settings"].preview.post(
          {
            matterNumberPattern: debouncedPattern,
            matterNumberPadding: debouncedPadding,
          },
          { fetch: { signal } },
        ),
      ),
  });
  const preview = previewData?.preview ?? null;

  const updateMutation = useSettingsMutation({
    mutationFn: async () =>
      unwrapEden(
        await api["organization-settings"].post({
          matterNumberPattern: pattern,
          matterNumberPadding: padding,
        }),
      ),
    invalidate: organizationSettingsKeys.all,
    successToast: { title: t("success.matterNumberingUpdated") },
    errorToast: { title: t("errors.actionFailed") },
  });

  const selectedPreset =
    PATTERN_PRESETS.find((p) => p.value === pattern)?.value ?? "custom";

  return (
    <Frame>
      <FramePanel>
        <div className="flex flex-col gap-3 p-1">
          <Field>
            <FieldLabel>{t("organization.matterNumber.pattern")}</FieldLabel>
            <Select
              onValueChange={(val) => {
                if (!val) {
                  return;
                }

                if (val === "custom") {
                  setIsCustom(true);
                  return;
                }

                setIsCustom(false);
                setPattern(val);
              }}
              value={selectedPreset}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                {[
                  ...PATTERN_PRESETS.map((p) => (
                    <SelectItem key={p.value} value={p.value}>
                      {t(`organization.matterNumber.presets.${p.key}`)}
                    </SelectItem>
                  )),
                  <SelectItem key="custom" value="custom">
                    {t("organization.matterNumber.presets.custom")}
                  </SelectItem>,
                ]}
              </SelectPopup>
            </Select>
          </Field>
          {isCustom && (
            <Field>
              <Input
                onChange={(e) => setPattern(e.target.value)}
                placeholder="{YYYY}/{SEQ}"
                value={pattern}
              />
              <p className="text-muted-foreground text-xs">
                {t("organization.matterNumber.tokenHelp")}
              </p>
            </Field>
          )}
          <Field>
            <FieldLabel>{t("organization.matterNumber.padding")}</FieldLabel>
            <Select
              onValueChange={(val) => {
                if (val) {
                  setPadding(Number(val));
                }
              }}
              value={String(padding)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                {PADDING_OPTIONS.map((p) => (
                  <SelectItem key={p} value={String(p)}>
                    {p}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <p className="text-muted-foreground text-xs">
              {t("organization.matterNumber.paddingDescription")}
            </p>
          </Field>
          {preview && (
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-xs">
                {t("organization.matterNumber.nextPreview")}
              </span>
              <span className="bg-muted rounded border px-2 py-1 font-mono text-sm">
                {preview}
              </span>
            </div>
          )}
          <Button
            className="self-start"
            loading={updateMutation.isPending}
            onClick={() => updateMutation.mutate()}
            size="sm"
          >
            {t("common.saveChanges")}
          </Button>
        </div>
      </FramePanel>
    </Frame>
  );
};
