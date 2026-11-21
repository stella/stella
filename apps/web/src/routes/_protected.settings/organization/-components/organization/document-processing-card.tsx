import { useQuery } from "@tanstack/react-query";

import { Checkbox } from "@stll/ui/checkbox";
import { SettingsPanel, settingsRowIds } from "@stll/ui/settings";

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
    return (
      <SettingsPanel>
        <QueryViewFeedback view={settingsView} />
      </SettingsPanel>
    );
  }

  const enabled =
    value ?? settings.documentProcessingMode === SEARCHABLE_TEXT_MODE;
  const ids = settingsRowIds(DOCUMENT_PROCESSING_CARD.id);
  return (
    <AIToggleCardFrame
      description={DOCUMENT_PROCESSING_CARD.description}
      id={DOCUMENT_PROCESSING_CARD.id}
      notice={
        settingsView.type === "items" &&
        settingsView.refetchError !== undefined ? (
          <QueryViewFeedback view={settingsView} />
        ) : undefined
      }
      title={DOCUMENT_PROCESSING_CARD.title}
      toggle={
        <Checkbox
          aria-describedby={ids.description}
          aria-labelledby={ids.label}
          id={ids.control}
          checked={enabled}
          disabled={disabled}
          onCheckedChange={onChange}
        />
      }
    >
      {feedback.status === "idle" ? undefined : (
        <AISettingsSectionFeedback feedback={feedback} />
      )}
    </AIToggleCardFrame>
  );
};
