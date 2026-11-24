import { useQuery } from "@tanstack/react-query";

import { SettingsPanel, settingsRowIds } from "@stll/ui/settings";
import { Switch } from "@stll/ui/switch";

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
    return (
      <SettingsPanel>
        <QueryViewFeedback view={settingsView} />
      </SettingsPanel>
    );
  }

  const enabled = value ?? settings.memoryExtractionEnabled;
  const ids = settingsRowIds(MEMORY_EXTRACTION_CARD.id);

  return (
    <AIToggleCardFrame
      description={MEMORY_EXTRACTION_CARD.description}
      id={MEMORY_EXTRACTION_CARD.id}
      notice={
        settingsView.type === "items" &&
        settingsView.refetchError !== undefined ? (
          <QueryViewFeedback view={settingsView} />
        ) : undefined
      }
      title={MEMORY_EXTRACTION_CARD.title}
      toggle={
        <Switch
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
