import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Frame, FramePanel } from "@stll/ui/frame";
import { Trash2Icon } from "@stll/ui/icons";

import { QueryViewFeedback } from "@/components/query-view-feedback";
import { SecretInput } from "@/components/secret-input";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { deepLConfigOptions } from "@/lib/deepl/queries";
import { useQueryView } from "@/lib/use-query-view";

import { AISettingsSectionFeedback } from "./ai-settings-section";
import type { KeySettingsSectionProps } from "./ai-settings-section";

export const DeepLKeyCard = ({
  draft,
  onChange,
  onRemove,
  disabled,
  feedback,
}: KeySettingsSectionProps) => {
  const t = useTranslations("translate.settings");
  const tCommon = useTranslations("common");
  const { activeOrganizationId } = useAuthenticatedUser();

  const settingsQuery = useQuery(
    deepLConfigOptions({ organizationId: activeOrganizationId }),
  );
  const settingsView = useQueryView(settingsQuery);
  const deeplConfig =
    settingsView.type === "items" ? settingsView.items : undefined;

  const removeLabel = tCommon("remove");

  if (settingsView.type !== "items") {
    return <QueryViewFeedback view={settingsView} />;
  }

  return (
    <div className="flex flex-col gap-4">
      <QueryViewFeedback view={settingsView} />
      <div>
        <h3 className="text-base font-medium">{t("title")}</h3>
        <p className="text-muted-foreground text-sm">{t("description")}</p>
      </div>

      {draft.action !== "cleared" && deeplConfig?.configured === true && (
        <div className="flex items-center justify-between gap-2">
          <div className="bg-muted flex flex-wrap items-center gap-2 rounded border px-3 py-2">
            <span className="text-muted-foreground text-xs">
              {t("currentKey")}:
            </span>
            <span className="font-mono text-xs">
              {deeplConfig.apiKeyMasked}
            </span>
            <span className="text-muted-foreground text-xs">
              ({deeplConfig.tier === "free" ? t("tierFree") : t("tierPro")})
            </span>
          </div>
          <Button
            aria-label={removeLabel}
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
            <label className="text-sm font-medium" htmlFor="deepl-api-key">
              {t("apiKeyLabel")}
            </label>
            <SecretInput
              autoComplete="off"
              disabled={disabled}
              id="deepl-api-key"
              onChange={(e) => onChange(e.target.value)}
              placeholder={t("apiKeyPlaceholder")}
              value={draft.action === "set" ? draft.apiKey : ""}
            />
          </div>
        </FramePanel>
      </Frame>

      {draft.action === "cleared" && (
        <p className="text-muted-foreground text-sm">
          {tCommon("unsavedChanges")}
        </p>
      )}
      <AISettingsSectionFeedback feedback={feedback} />
    </div>
  );
};
