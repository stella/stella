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
  PROMPT_CACHING_CARD,
} from "./ai-toggle-card.pending";

export const PromptCachingCard = ({
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
    return <AIToggleCardPending {...PROMPT_CACHING_CARD} />;
  }
  if (!settings) {
    return <QueryViewFeedback view={settingsView} />;
  }

  const enabled = value ?? settings.promptCachingEnabled;

  return (
    <AIToggleCardFrame
      description={PROMPT_CACHING_CARD.description}
      notice={<QueryViewFeedback view={settingsView} />}
      title={PROMPT_CACHING_CARD.title}
      toggle={
        <Field className="flex-row items-center gap-2">
          <Checkbox
            checked={enabled}
            disabled={disabled}
            onCheckedChange={onChange}
          />
          <FieldLabel>{t(PROMPT_CACHING_CARD.label)}</FieldLabel>
        </Field>
      }
    >
      <AISettingsSectionFeedback feedback={feedback} />
    </AIToggleCardFrame>
  );
};
