import { useState } from "react";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useDebounce } from "use-debounce";
import { useTranslations } from "use-intl";

import { documentNamePatternProblem } from "@stll/api-contract/document-name";
import { Button } from "@stll/ui/button";
import { Field, FieldLabel } from "@stll/ui/field";
import { Input } from "@stll/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";
import { SwitchField } from "@stll/ui/switch";

import { DocumentNamePatternField } from "@/components/document-name-pattern-field";
import { MatterNumberPreview } from "@/components/matter-number-preview.pending";
import {
  QueryViewFeedback,
  SettledQueryViewFeedback,
} from "@/components/query-view-feedback";
import { api } from "@/lib/api";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { unwrapApiResponse } from "@/lib/errors/api";
import {
  organizationSettingsKeys,
  organizationSettingsOptions,
} from "@/lib/organization/settings-queries";
import { queryView } from "@/lib/query-view.logic";
import {
  MatterNumberingCardFrame,
  MatterNumberingCardPending,
  MatterNumberPreviewPending,
} from "@/routes/_protected.settings/organization/-components/organization/matter-numbering-card.pending";
import { useSettingsMutation } from "@/routes/_protected.settings/organization/-hooks/use-settings-mutation";

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
  const { activeOrganizationId, id: userId } = useAuthenticatedUser();
  const settingsQuery = useQuery(
    organizationSettingsOptions({
      organizationId: activeOrganizationId,
      userId,
    }),
  );
  const settingsView = queryView(settingsQuery);
  const settings =
    settingsView.type === "items" ? settingsView.items : undefined;

  if (settingsView.type === "pending") {
    return <MatterNumberingCardPending />;
  }
  if (!settings) {
    return <QueryViewFeedback view={settingsView} />;
  }

  return (
    <>
      <QueryViewFeedback view={settingsView} />
      <MatterNumberingCardBody
        // A new organization mounts a new body, so its preview never starts
        // from the last organization's number.
        key={`${activeOrganizationId}|${settings.matterNumberPattern}|${settings.matterNumberPadding}|${settings.documentNamePattern ?? ""}`}
        settings={settings}
      />
    </>
  );
};

type MatterNumberingSettings = {
  documentNamePattern: string | null;
  matterNumberPattern: string;
  matterNumberPadding: number;
  matterNumberingEnabled: boolean;
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
  // Empty leaves uploaded names alone.
  const [namePattern, setNamePattern] = useState(
    settings.documentNamePattern ?? "",
  );
  const namePatternProblem =
    namePattern === "" ? null : documentNamePatternProblem(namePattern);
  const [isCustom, setIsCustom] = useState(
    () =>
      !PATTERN_PRESETS.some(
        (preset) => preset.value === settings.matterNumberPattern,
      ),
  );
  const [debouncedPattern] = useDebounce(pattern, 300);
  const [debouncedPadding] = useDebounce(padding, 300);
  const previewQuery = useQuery({
    queryKey: [
      ...organizationSettingsKeys.byOrganization(activeOrganizationId),
      "matter-number-preview",
      debouncedPattern,
      debouncedPadding,
    ],
    queryFn: async ({ signal }) =>
      unwrapApiResponse(
        await api["organization-settings"].preview.post(
          {
            matterNumberPattern: debouncedPattern,
            matterNumberPadding: debouncedPadding,
          },
          { fetch: { signal } },
        ),
      ),
    // A new pattern keeps the last number in the chip until its own
    // preview arrives, so typing never empties the row. The body is keyed by
    // organization, so the number kept is always this organization's.
    placeholderData: keepPreviousData,
  });
  const previewView = queryView(previewQuery);
  const previewData =
    previewView.type === "items" ? previewView.items : undefined;
  const preview = previewData?.preview ?? null;

  const numberingToggle = useSettingsMutation({
    exceptionScope: {
      type: "handler",
      handlerId: "MatterNumberingCardBody.numberingToggle.useSettingsMutation",
    },
    mutationFn: async (enabled: boolean) =>
      unwrapApiResponse(
        await api["organization-settings"].post({
          matterNumberingEnabled: enabled,
        }),
      ),
    invalidate: organizationSettingsKeys.all,
    successToast: { title: t("success.matterNumberingUpdated") },
    errorToast: { title: t("errors.actionFailed") },
  });

  const updateMutation = useSettingsMutation({
    exceptionScope: {
      type: "handler",
      handlerId: "MatterNumberingCardBody.updateMutation.useSettingsMutation",
    },
    mutationFn: async () =>
      unwrapApiResponse(
        await api["organization-settings"].post({
          matterNumberPattern: pattern,
          matterNumberPadding: padding,
          documentNamePattern: namePattern === "" ? null : namePattern,
        }),
      ),
    invalidate: organizationSettingsKeys.all,
    successToast: { title: t("success.matterNumberingUpdated") },
    errorToast: { title: t("errors.actionFailed") },
  });

  const selectedPreset =
    PATTERN_PRESETS.find((p) => p.value === pattern)?.value ?? "custom";

  return (
    <MatterNumberingCardFrame
      numberingToggle={
        <SwitchField
          checked={settings.matterNumberingEnabled}
          description={t("organization.matterNumber.showInTitleDescription")}
          disabled={numberingToggle.isPending}
          label={t("organization.matterNumber.showInTitle")}
          onCheckedChange={(checked) => {
            numberingToggle.mutate(checked);
          }}
        />
      }
      pattern={
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
                  {t("common.custom")}
                </SelectItem>,
              ]}
            </SelectPopup>
          </Select>
        </Field>
      }
      customPattern={
        isCustom && (
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
        )
      }
      padding={
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
      }
      preview={
        <>
          {previewView.type === "pending" ? (
            <MatterNumberPreviewPending />
          ) : (
            preview && (
              <MatterNumberPreview
                label={t("organization.matterNumber.nextPreview")}
              >
                {preview}
              </MatterNumberPreview>
            )
          )}
          <SettledQueryViewFeedback view={previewView} />
        </>
      }
      documentNaming={
        <DocumentNamePatternField
          onChange={setNamePattern}
          problem={namePatternProblem}
          value={namePattern}
        />
      }
      save={
        <Button
          className="self-start"
          disabled={updateMutation.isPending || namePatternProblem !== null}
          disabledReason={
            updateMutation.isPending
              ? t("common.saving")
              : t("organization.documentNaming.invalid")
          }
          loading={updateMutation.isPending}
          onClick={() => updateMutation.mutate()}
          size="sm"
        >
          {t("common.saveChanges")}
        </Button>
      }
    />
  );
};
