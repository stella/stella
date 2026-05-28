/**
 * Settings card for the organisation's DeepL API key.
 *
 * Mirrors the AI config BYOK pattern: keys are validated via
 * a server-side probe before persisting, are stored encrypted,
 * and only ever surface to the UI as a masked preview.
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
import { deepLAvailabilityOptions, deepLKeys } from "@/lib/deepl/queries";
import { toAPIError } from "@/lib/errors";

export const DeepLKeyCard = () => {
  const t = useTranslations("translate.settings");
  const tCommon = useTranslations("common");
  const tErrors = useTranslations("errors");
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  const activeOrganizationId = useRouteContext({
    from: "/_protected",
    select: (ctx) => ctx.user.activeOrganizationId,
  });

  const { data: availability } = useQuery(
    deepLAvailabilityOptions({ organizationId: activeOrganizationId }),
  );

  const [apiKey, setApiKey] = useState("");

  const saveMutation = useMutation({
    mutationFn: async () => {
      const response = await api["organization-settings"].deepl.post({
        apiKey,
      });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    onSuccess: async () => {
      setApiKey("");
      await queryClient.invalidateQueries({
        queryKey: deepLKeys.availability({
          organizationId: activeOrganizationId,
        }),
      });
      stellaToast.add({
        title: t("saved"),
        description: t("savedDescription"),
        type: "success",
      });
    },
    onError: (error: unknown) => {
      analytics.captureError(error);
      stellaToast.add({
        title: tErrors("actionFailed"),
        description: error instanceof Error ? error.message : undefined,
        type: "error",
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      const response = await api["organization-settings"].deepl.delete();
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: deepLKeys.availability({
          organizationId: activeOrganizationId,
        }),
      });
      stellaToast.add({
        title: t("removed"),
        description: t("removedDescription"),
        type: "success",
      });
    },
    onError: (error: unknown) => {
      analytics.captureError(error);
      stellaToast.add({
        title: tErrors("actionFailed"),
        type: "error",
      });
    },
  });

  const isConfigured = availability?.configured === true;
  const canSave = apiKey.trim().length > 0 && !saveMutation.isPending;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="text-base font-medium">{t("title")}</h3>
        <p className="text-muted-foreground text-sm">{t("description")}</p>
      </div>

      {isConfigured && (
        <div className="flex items-center justify-between gap-2">
          <div className="bg-muted flex flex-wrap items-center gap-2 rounded border px-3 py-2">
            <span className="text-muted-foreground text-xs">
              {t("currentKey")}:
            </span>
            <span className="font-mono text-xs">
              {availability.apiKeyMasked}
            </span>
            <span className="text-muted-foreground text-xs">
              ({availability.tier === "free" ? t("tierFree") : t("tierPro")})
            </span>
          </div>
          <Button
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
            <label className="text-sm font-medium" htmlFor="deepl-api-key">
              {t("apiKeyLabel")}
            </label>
            <Input
              autoComplete="off"
              disabled={saveMutation.isPending}
              id="deepl-api-key"
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={t("apiKeyPlaceholder")}
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
        {isConfigured ? tCommon("saveChanges") : t("save")}
      </Button>
    </div>
  );
};
