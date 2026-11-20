import { useId } from "react";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { Checkbox } from "@stll/ui/checkbox";
import { Field, FieldLabel } from "@stll/ui/field";

import { QueryViewFeedback } from "@/components/query-view-feedback";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { queryView } from "@/lib/query-view.logic";
import { organizationSettingsOptions } from "@/queries/organization-settings";

import { AISettingsSectionFeedback } from "./ai-settings-section";
import type { ToggleSettingsSectionProps } from "./ai-settings-section";
import {
  AIToggleCardFrame,
  AIToggleCardPending,
  DOCUMENT_PROCESSING_CARD,
} from "./ai-toggle-card.pending";

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
  const settingsView = queryView(settingsQuery);
  const settings =
    settingsView.type === "items" ? settingsView.items : undefined;

  if (settingsView.type === "pending") {
    return <AIToggleCardPending {...DOCUMENT_PROCESSING_CARD} />;
  }
  if (!settings) {
    return <QueryViewFeedback view={settingsView} />;
  }

  const enabled =
    value ?? settings.documentProcessingMode === SEARCHABLE_TEXT_MODE;
  return (
    <AIToggleCardFrame
      description={DOCUMENT_PROCESSING_CARD.description}
      notice={<QueryViewFeedback view={settingsView} />}
      title={DOCUMENT_PROCESSING_CARD.title}
      toggle={
        <Field className="flex-row items-center gap-2">
          <Checkbox
            checked={enabled}
            disabled={disabled}
            id={checkboxId}
            onCheckedChange={onChange}
          />
          <FieldLabel htmlFor={checkboxId}>
            {t(DOCUMENT_PROCESSING_CARD.label)}
          </FieldLabel>
        </Field>
      }
    >
      <AISettingsSectionFeedback feedback={feedback} />
    </AIToggleCardFrame>
  );
};
