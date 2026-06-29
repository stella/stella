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

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { Trash2Icon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { Frame, FramePanel } from "@stll/ui/components/frame";
import { Input } from "@stll/ui/components/input";
import { stellaToast } from "@stll/ui/components/toast";

import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import {
  webSearchConfigOptions,
  webSearchKeysKeys,
} from "@/lib/web-search/queries";

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
  const analytics = useAnalytics();
  const queryClient = useQueryClient();

  const [apiKey, setApiKey] = useState("");

  const saveMutation = useMutation({
    mutationFn: async () => {
      const response = await api["organization-settings"][
        "web-search-key"
      ].post({ kind, apiKey });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    onSuccess: async () => {
      setApiKey("");
      await queryClient.invalidateQueries({ queryKey: webSearchKeysKeys.all });
      stellaToast.add({
        title: t("success.organizationUpdated"),
        type: "success",
      });
    },
    onError: (error: unknown) => {
      analytics.captureError(error);
      stellaToast.add({
        title: t("errors.actionFailed"),
        description: error instanceof Error ? error.message : undefined,
        type: "error",
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      const response = await api["organization-settings"][
        "web-search-key"
      ].delete({ kind });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: webSearchKeysKeys.all });
      stellaToast.add({
        title: t("success.organizationUpdated"),
        type: "success",
      });
    },
    onError: (error: unknown) => {
      analytics.captureError(error);
      stellaToast.add({ title: t("errors.actionFailed"), type: "error" });
    },
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
