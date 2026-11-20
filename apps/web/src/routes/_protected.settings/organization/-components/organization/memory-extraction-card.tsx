import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { Checkbox } from "@stll/ui/checkbox";
import { Field, FieldLabel } from "@stll/ui/field";

import { QueryViewFeedback } from "@/components/query-view-feedback";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { organizationSettingsOptions } from "@/lib/organization/settings-queries";
import { queryView } from "@/lib/query-view.logic";

import { AISettingsSectionFeedback } from "./ai-settings-section";
import type { ToggleSettingsSectionProps } from "./ai-settings-section";
import {
  AIToggleCardFrame,
  AIToggleCardPending,
  MEMORY_EXTRACTION_CARD,
} from "./ai-toggle-card.pending";

export const MemoryExtractionCard = ({
  value,
  onChange,
  disabled,
  feedback,
}: ToggleSettingsSectionProps) => {
  const t = useTranslations();
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
    return <AIToggleCardPending {...MEMORY_EXTRACTION_CARD} />;
  }
  if (!settings) {
    return <QueryViewFeedback view={settingsView} />;
  }

  const enabled = value ?? settings.memoryExtractionEnabled;

  return (
    <AIToggleCardFrame
      description={MEMORY_EXTRACTION_CARD.description}
      notice={<QueryViewFeedback view={settingsView} />}
      title={MEMORY_EXTRACTION_CARD.title}
      toggle={
        <Field className="flex-row items-center gap-2">
          <Checkbox
            checked={enabled}
            disabled={disabled}
            onCheckedChange={onChange}
          />
          <FieldLabel>{t(MEMORY_EXTRACTION_CARD.label)}</FieldLabel>
        </Field>
      }
    >
      <AISettingsSectionFeedback feedback={feedback} />
    </AIToggleCardFrame>
  );
};
