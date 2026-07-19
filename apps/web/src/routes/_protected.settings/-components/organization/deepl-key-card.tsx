/**
 * Settings card for the organisation's DeepL API key.
 *
 * Mirrors the AI config BYOK pattern: keys are validated via
 * a server-side probe before persisting, are stored encrypted,
 * and only ever surface to the UI as a masked preview.
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
import { deepLConfigOptions, deepLKeys } from "@/lib/deepl/queries";
import { unwrapEden } from "@/lib/errors/api";
import { useSettingsMutation } from "@/routes/_protected.settings/-hooks/use-settings-mutation";

export const DeepLKeyCard = () => {
  const t = useTranslations("translate.settings");
  const tCommon = useTranslations("common");
  const tErrors = useTranslations("errors");
  const activeOrganizationId = useRouteContext({
    from: "/_protected",
    select: (ctx) => ctx.user.activeOrganizationId,
  });

  const { data: deeplConfig } = useQuery(
    deepLConfigOptions({ organizationId: activeOrganizationId }),
  );

  const [apiKey, setApiKey] = useState("");

  const saveMutation = useSettingsMutation({
    mutationFn: async () =>
      unwrapEden(await api["organization-settings"].deepl.post({ apiKey })),
    invalidate: deepLKeys.all,
    successToast: { title: t("saved"), description: t("savedDescription") },
    errorToast: {
      title: tErrors("actionFailed"),
      description: tErrors("actionFailed"),
    },
    onSuccess: () => setApiKey(""),
  });

  const deleteMutation = useSettingsMutation({
    mutationFn: async () =>
      unwrapEden(await api["organization-settings"].deepl.delete()),
    invalidate: deepLKeys.all,
    successToast: { title: t("removed"), description: t("removedDescription") },
    errorToast: { title: tErrors("actionFailed") },
  });

  const isConfigured = deeplConfig?.configured === true;
  const canSave = apiKey.trim().length > 0 && !saveMutation.isPending;
  const removeLabel = t("remove");

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="text-base font-medium">{t("title")}</h3>
        <p className="text-muted-foreground text-sm">{t("description")}</p>
      </div>

      {deeplConfig?.configured === true && (
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
