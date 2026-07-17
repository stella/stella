/**
 * Settings card for the organisation's web-search BYOK keys.
 *
 * Mirrors the DeepL key card: keys are validated via a server-side
 * probe before persisting, stored encrypted, and only ever surface to
 * the UI as a masked preview. One card covers both keys (search
 * provider + page reader) via a shared per-kind field. Only the
 * feature-specific copy lives under `webSearch.settings`; everything
 * generic reuses existing keys.
 */

import { useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { Trash2Icon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { Frame, FramePanel } from "@stll/ui/components/frame";
import { Input } from "@stll/ui/components/input";

import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import {
  webSearchConfigOptions,
  webSearchKeysKeys,
} from "@/lib/web-search/queries";
import { useSettingsMutation } from "@/routes/_protected.settings/-hooks/use-settings-mutation";

type WebSearchKeyKind = "search" | "fetch";

type WebSearchKeyState =
  | { configured: false; platformFallback: boolean }
  | { configured: true; apiKeyMasked: string; platformFallback: boolean };

export const WebSearchKeysCard = () => {
  const t = useTranslations();
  const activeOrganizationId = useRouteContext({
    from: "/_protected",
    select: (ctx) => ctx.user.activeOrganizationId,
  });

  const { data: config } = useQuery(
    webSearchConfigOptions({ organizationId: activeOrganizationId }),
  );

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h3 className="text-base font-medium">
          {t("webSearch.settings.title")}
        </h3>
        <p className="text-muted-foreground text-sm">
          {t("webSearch.settings.description")}
        </p>
      </div>

      <WebSearchKeyField kind="search" state={config?.search} />
      <WebSearchKeyField kind="fetch" state={config?.fetch} />
    </div>
  );
};

type WebSearchKeyFieldProps = {
  kind: WebSearchKeyKind;
  state: WebSearchKeyState | undefined;
};

const WebSearchKeyField = ({ kind, state }: WebSearchKeyFieldProps) => {
  const t = useTranslations();

  const [apiKey, setApiKey] = useState("");

  const saveMutation = useSettingsMutation({
    mutationFn: async () =>
      unwrapEden(
        await api["organization-settings"]["web-search-key"].post({
          kind,
          apiKey,
        }),
      ),
    invalidate: webSearchKeysKeys.all,
    successToast: { title: t("success.organizationUpdated") },
    errorToast: {
      title: t("errors.actionFailed"),
      description: t("errors.actionFailed"),
    },
    onSuccess: () => setApiKey(""),
  });

  const deleteMutation = useSettingsMutation({
    mutationFn: async () =>
      unwrapEden(
        await api["organization-settings"]["web-search-key"].delete({ kind }),
      ),
    invalidate: webSearchKeysKeys.all,
    successToast: { title: t("success.organizationUpdated") },
    errorToast: { title: t("errors.actionFailed") },
  });

  const title =
    kind === "search"
      ? t("webSearch.settings.searchTitle")
      : t("webSearch.settings.fetchTitle");

  const isConfigured = state?.configured === true;
  const canSave = apiKey.trim().length > 0 && !saveMutation.isPending;
  const fieldId = `web-search-key-${kind}`;

  return (
    <div className="flex flex-col gap-3">
      <h4 className="text-sm font-medium">{title}</h4>

      {!isConfigured && state?.platformFallback === true && (
        <p className="text-muted-foreground text-xs">
          {t("webSearch.settings.platformFallback")}
        </p>
      )}

      {state?.configured === true && (
        <div className="flex items-center justify-between gap-2">
          <div className="bg-muted flex flex-wrap items-center gap-2 rounded border px-3 py-2">
            <span className="text-muted-foreground text-xs">
              {t("translate.settings.currentKey")}:
            </span>
            <span className="font-mono text-xs">{state.apiKeyMasked}</span>
          </div>
          <Button
            aria-label={t("common.remove")}
            loading={deleteMutation.isPending}
            onClick={() => deleteMutation.mutate()}
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
            <Input
              autoComplete="off"
              disabled={saveMutation.isPending}
              id={fieldId}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={t("organization.aiConfig.apiKeyPlaceholder")}
              type="password"
              value={apiKey}
            />
          </div>
        </FramePanel>
      </Frame>

      <Button
        className="self-start"
        disabled={!canSave}
        loading={saveMutation.isPending}
        onClick={() => saveMutation.mutate()}
        size="sm"
      >
        {isConfigured ? t("common.saveChanges") : t("common.save")}
      </Button>
    </div>
  );
};
