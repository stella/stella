import { useId } from "react";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { Checkbox } from "@stll/ui/checkbox";
import { Field, FieldLabel } from "@stll/ui/field";
import { Frame, FramePanel } from "@stll/ui/frame";

import { QueryViewFeedback } from "@/components/query-view-feedback";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { useQueryView } from "@/lib/use-query-view";
import { organizationSettingsOptions } from "@/queries/organization-settings";

import { AISettingsSectionFeedback } from "./ai-settings-section";
import type { ToggleSettingsSectionProps } from "./ai-settings-section";

const SEARCHABLE_TEXT_MODE = "searchable-text";

export const DocumentProcessingCard = ({
  value,
  onChange,
  disabled,
  feedback,
}: ToggleSettingsSectionProps) => {
  const t = useTranslations();
  const checkboxId = useId();
  const { activeOrganizationId, id: userId } = useAuthenticatedUser();
  const settingsQuery = useQuery(
    organizationSettingsOptions({
      organizationId: activeOrganizationId,
      userId,
    }),
  );
  const settingsView = useQueryView(settingsQuery);
  const settings =
    settingsView.type === "items" ? settingsView.items : undefined;

  if (!settings) {
    return <QueryViewFeedback view={settingsView} />;
  }

  const enabled =
    value ?? settings.documentProcessingMode === SEARCHABLE_TEXT_MODE;
  return (
    <Frame>
      <QueryViewFeedback view={settingsView} />
      <FramePanel>
        <div className="flex flex-col gap-3 p-1">
          <h2 className="text-sm font-medium">
            {t("settings.organization.documentProcessing.title")}
          </h2>
          <p className="text-muted-foreground text-xs">
            {t("settings.organization.documentProcessing.description")}
          </p>
          <Field className="flex-row items-center gap-2">
            <Checkbox
              checked={enabled}
              disabled={disabled}
              id={checkboxId}
              onCheckedChange={onChange}
            />
            <FieldLabel htmlFor={checkboxId}>
              {t("settings.organization.documentProcessing.toggleLabel")}
            </FieldLabel>
          </Field>
          <AISettingsSectionFeedback feedback={feedback} />
        </div>
      </FramePanel>
    </Frame>
  );
};
