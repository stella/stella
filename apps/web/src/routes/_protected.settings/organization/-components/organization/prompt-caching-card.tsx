import { useQuery } from "@tanstack/react-query";

import { Checkbox } from "@stll/ui/checkbox";
import { SettingsPanel, settingsRowIds } from "@stll/ui/settings";

import { QueryViewFeedback } from "@/components/query-view-feedback";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { organizationSettingsOptions } from "@/lib/organization/settings-queries";
import { queryView } from "@/lib/query-view.logic";

import { AISettingsSectionFeedback } from "./ai-settings-section";
import type { ToggleSettingsSectionProps } from "./ai-settings-section";
import {
  AIToggleCardFrame,
  AIToggleCardPending,
  PROMPT_CACHING_CARD,
} from "./ai-toggle-card.pending";

export const PromptCachingCard = ({
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
    return <AIToggleCardPending {...PROMPT_CACHING_CARD} />;
  }
  if (!settings) {
    return (
      <SettingsPanel>
        <QueryViewFeedback view={settingsView} />
      </SettingsPanel>
    );
  }

  const enabled = value ?? settings.promptCachingEnabled;
  const ids = settingsRowIds(PROMPT_CACHING_CARD.id);

  return (
    <AIToggleCardFrame
      description={PROMPT_CACHING_CARD.description}
      id={PROMPT_CACHING_CARD.id}
      notice={
        settingsView.type === "items" &&
        settingsView.refetchError !== undefined ? (
          <QueryViewFeedback view={settingsView} />
        ) : undefined
      }
      title={PROMPT_CACHING_CARD.title}
      toggle={
        <Checkbox
          aria-describedby={ids.description}
          aria-labelledby={ids.label}
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
