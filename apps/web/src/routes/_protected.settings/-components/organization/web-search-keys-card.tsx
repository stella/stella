import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Frame, FramePanel } from "@stll/ui/frame";
import { Trash2Icon } from "@stll/ui/icons";

import { QueryViewFeedback } from "@/components/query-view-feedback";
import { SecretInput } from "@/components/secret-input";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { useQueryView } from "@/lib/use-query-view";
import { webSearchConfigOptions } from "@/lib/web-search/queries";

import { AISettingsSectionFeedback } from "./ai-settings-section";
import type { KeySettingsSectionProps } from "./ai-settings-section";

type WebSearchKeyKind = "search" | "fetch";

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
  const t = useTranslations();
  const { activeOrganizationId } = useAuthenticatedUser();

  const settingsQuery = useQuery(
    webSearchConfigOptions({ organizationId: activeOrganizationId }),
  );
  const settingsView = useQueryView(settingsQuery);
  const config = settingsView.type === "items" ? settingsView.items : undefined;

  if (settingsView.type !== "items") {
    return <QueryViewFeedback view={settingsView} />;
  }

  return (
    <div className="flex flex-col gap-6">
      <QueryViewFeedback view={settingsView} />
      <div>
        <h3 className="text-base font-medium">
          {t("webSearch.settings.title")}
        </h3>
        <p className="text-muted-foreground text-sm">
          {t("webSearch.settings.description")}
        </p>
      </div>

      <WebSearchKeyField
        kind="search"
        state={config?.search}
        controller={search}
      />
      <WebSearchKeyField
        kind="fetch"
        state={config?.fetch}
        controller={fetch}
      />
    </div>
  );
};

type WebSearchKeyFieldProps = {
  kind: WebSearchKeyKind;
  state: WebSearchKeyState | undefined;
  controller: KeySettingsSectionProps;
};

const WebSearchKeyField = ({
  kind,
  state,
  controller: { draft, onChange, onRemove, feedback, disabled },
}: WebSearchKeyFieldProps) => {
  const t = useTranslations();

  const title =
    kind === "search"
      ? t("webSearch.settings.searchTitle")
      : t("webSearch.settings.fetchTitle");

  const isConfigured = state?.configured === true;
  const fieldId = `web-search-key-${kind}`;

  return (
    <div className="flex flex-col gap-3">
      <h4 className="text-sm font-medium">{title}</h4>

      {!isConfigured && state?.platformFallback === true && (
        <p className="text-muted-foreground text-xs">
          {t("webSearch.settings.platformFallback")}
        </p>
      )}

      {draft.action !== "cleared" && state?.configured === true && (
        <div className="flex items-center justify-between gap-2">
          <div className="bg-muted flex flex-wrap items-center gap-2 rounded border px-3 py-2">
            <span className="text-muted-foreground text-xs">
              {t("translate.settings.currentKey")}:
            </span>
            <span className="font-mono text-xs">{state.apiKeyMasked}</span>
          </div>
          <Button
            aria-label={t("common.remove")}
            disabled={disabled}
            onClick={onRemove}
            size="sm"
            variant="ghost"
          >
            <Trash2Icon className="size-4" />
          </Button>
        </div>
      )}

      <Frame>
        <FramePanel>
          <div className="flex flex-col gap-3 p-1">
            <label className="text-sm font-medium" htmlFor={fieldId}>
              {t("organization.aiConfig.apiKey")}
            </label>
            <SecretInput
              autoComplete="off"
              disabled={disabled}
              id={fieldId}
              onChange={(e) => onChange(e.target.value)}
              placeholder={t("organization.aiConfig.apiKeyPlaceholder")}
              value={draft.action === "set" ? draft.apiKey : ""}
            />
          </div>
        </FramePanel>
      </Frame>

      {draft.action === "cleared" && (
        <p className="text-muted-foreground text-sm">
          {t("common.unsavedChanges")}
        </p>
      )}
      <AISettingsSectionFeedback feedback={feedback} />
    </div>
  );
};
