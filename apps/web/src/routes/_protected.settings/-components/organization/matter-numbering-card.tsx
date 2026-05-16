import { useEffect, useState } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useDebouncedCallback } from "use-debounce";
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
import { stellaToast } from "@stll/ui/components/toast";

import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import {
  organizationSettingsKeys,
  organizationSettingsOptions,
} from "@/routes/_protected.organization/-settings-queries";

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
  const { data: settings } = useQuery(organizationSettingsOptions);

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
  const analytics = useAnalytics();
  const queryClient = useQueryClient();

  const [pattern, setPattern] = useState(settings.matterNumberPattern);
  const [padding, setPadding] = useState(settings.matterNumberPadding);
  const [isCustom, setIsCustom] = useState(
    () =>
      !PATTERN_PRESETS.some(
        (preset) => preset.value === settings.matterNumberPattern,
      ),
  );
  const [preview, setPreview] = useState<string | null>(null);

  const fetchPreview = useDebouncedCallback(async (p: string, pad: number) => {
    const response = await api["organization-settings"].preview.post({
      matterNumberPattern: p,
      matterNumberPadding: pad,
    });
    if (!response.error) {
      setPreview(response.data.preview);
    }
  }, 300);

  useEffect(() => {
    // eslint-disable-next-line typescript/no-floating-promises
    fetchPreview(pattern, padding);
  }, [pattern, padding, fetchPreview]);

  const updateMutation = useMutation({
    mutationFn: async () => {
      const response = await api["organization-settings"].post({
        matterNumberPattern: pattern,
        matterNumberPadding: padding,
      });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: organizationSettingsKeys.all,
      });
      stellaToast.add({
        title: t("success.matterNumberingUpdated"),
        type: "success",
      });
    },
    onError: (error) => {
      analytics.captureError(error);
      stellaToast.add({
        title: t("errors.actionFailed"),
        type: "error",
      });
    },
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
