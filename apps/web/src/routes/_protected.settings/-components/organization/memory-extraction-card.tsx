import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { Checkbox } from "@stll/ui/checkbox";
import { Field, FieldLabel } from "@stll/ui/field";
import { Frame, FramePanel } from "@stll/ui/frame";

import { QueryViewFeedback } from "@/components/query-view-feedback";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { organizationSettingsOptions } from "@/lib/organization/settings-queries";
import { useQueryView } from "@/lib/use-query-view";

import { AISettingsSectionFeedback } from "./ai-settings-section";
import type { ToggleSettingsSectionProps } from "./ai-settings-section";

export const MemoryExtractionCard = ({
  value,
  onChange,
  disabled,
  feedback,
}: ToggleSettingsSectionProps) => {
  const t = useTranslations("settings.organization.memoryExtraction");
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

  const enabled = value ?? settings.memoryExtractionEnabled;

  return (
    <Frame>
      <QueryViewFeedback view={settingsView} />
      <FramePanel>
        <div className="flex flex-col gap-3 p-1">
          <h2 className="text-sm font-medium">{t("title")}</h2>
          <p className="text-muted-foreground text-xs">{t("description")}</p>
          <Field className="flex-row items-center gap-2">
            <Checkbox
              checked={enabled}
              disabled={disabled}
              onCheckedChange={onChange}
            />
            <FieldLabel>{t("toggleLabel")}</FieldLabel>
          </Field>
          <AISettingsSectionFeedback feedback={feedback} />
        </div>
      </FramePanel>
    </Frame>
  );
};
