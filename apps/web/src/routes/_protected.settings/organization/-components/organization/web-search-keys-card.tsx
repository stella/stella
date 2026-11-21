import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Trash2Icon } from "@stll/ui/icons";
import { Label } from "@stll/ui/label";

import { QueryViewFeedback } from "@/components/query-view-feedback";
import { SecretInput } from "@/components/secret-input";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { queryView } from "@/lib/query-view.logic";
import { webSearchConfigOptions } from "@/lib/web-search/queries";

import {
  AIKeyFieldFrame,
  AIKeySectionHeading,
  WEB_SEARCH_KEY_FIELDS,
  WEB_SEARCH_KEYS_SECTION,
  WebSearchKeyFieldTitle,
  WebSearchKeysCardPending,
} from "./ai-key-card.pending";
import { AISettingsSectionFeedback } from "./ai-settings-section";
import type { KeySettingsSectionProps } from "./ai-settings-section";

type WebSearchKeyState =
  | { configured: false; platformFallback: boolean }
  | { configured: true; apiKeyMasked: string; platformFallback: boolean };

type WebSearchKeysCardProps = {
  search: KeySettingsSectionProps;
  fetch: KeySettingsSectionProps;
};

export const WebSearchKeysCard = ({
  search,
  fetch,
}: WebSearchKeysCardProps) => {
  const { activeOrganizationId } = useAuthenticatedUser();

  const settingsQuery = useQuery(
    webSearchConfigOptions({ organizationId: activeOrganizationId }),
  );
  const settingsView = queryView(settingsQuery);
  const config = settingsView.type === "items" ? settingsView.items : undefined;

  if (settingsView.type === "pending") {
    return <WebSearchKeysCardPending />;
  }
  if (settingsView.type !== "items") {
    return <QueryViewFeedback view={settingsView} />;
  }

  return (
    <div className="flex flex-col gap-6">
      <QueryViewFeedback view={settingsView} />
      <AIKeySectionHeading
        description={WEB_SEARCH_KEYS_SECTION.description}
        title={WEB_SEARCH_KEYS_SECTION.title}
      />

      {WEB_SEARCH_KEY_FIELDS.map((field) => (
        <WebSearchKeyField
          key={field.kind}
          field={field}
          state={config?.[field.kind]}
          controller={field.kind === "search" ? search : fetch}
        />
      ))}
    </div>
  );
};

type WebSearchKeyFieldProps = {
  field: (typeof WEB_SEARCH_KEY_FIELDS)[number];
  state: WebSearchKeyState | undefined;
  controller: KeySettingsSectionProps;
};

const WebSearchKeyField = ({
  field: { kind, title },
  state,
  controller: { draft, onChange, onRemove, feedback, disabled },
}: WebSearchKeyFieldProps) => {
  const t = useTranslations();

  const isConfigured = state?.configured === true;
  const fieldId = `web-search-key-${kind}`;

  return (
    <div className="flex flex-col gap-3">
      <WebSearchKeyFieldTitle title={title} />

      {!isConfigured && state?.platformFallback === true && (
        <p className="text-muted-foreground text-xs">
          {t("webSearch.settings.platformFallback")}
        </p>
      )}

      {draft.action !== "cleared" && state?.configured === true && (
        <div className="flex items-center justify-between gap-2">
          <div className="bg-muted flex flex-wrap items-center gap-2 rounded-sm border px-3 py-2">
            <span className="text-muted-foreground text-xs">
              {t("translate.settings.currentKey")}:
            </span>
            <span className="font-mono text-xs">{state.apiKeyMasked}</span>
          </div>
          <Button
            aria-label={t("common.remove")}
            disabled={disabled}
            disabledReason={t("common.saving")}
            onClick={onRemove}
            size="sm"
            tooltip={t("common.remove")}
            variant="ghost"
          >
            <Trash2Icon className="size-4" />
          </Button>
        </div>
      )}

      <AIKeyFieldFrame
        input={
          <SecretInput
            autoComplete="off"
            disabled={disabled}
            disabledReason={t("common.saving")}
            id={fieldId}
            onChange={(e) => onChange(e.target.value)}
            placeholder={t(WEB_SEARCH_KEYS_SECTION.placeholder)}
            value={draft.action === "set" ? draft.apiKey : ""}
          />
        }
        label={
          <Label htmlFor={fieldId}>{t(WEB_SEARCH_KEYS_SECTION.label)}</Label>
        }
      />

      {draft.action === "cleared" && (
        <p className="text-muted-foreground text-sm">
          {t("common.unsavedChanges")}
        </p>
      )}
      <AISettingsSectionFeedback feedback={feedback} />
    </div>
  );
};
