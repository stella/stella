import { useEffect, useState } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { Trash2Icon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { Frame, FramePanel } from "@stll/ui/components/frame";
import { stellaToast } from "@stll/ui/components/toast";

import { AIConfigProvidersEditor } from "@/components/ai-config-providers-editor";
import { AIConfigRoleModelPicker } from "@/components/ai-config-role-model-picker";
import {
  createProviderCredentialDraft,
  createDefaultRoleModels,
  ensureRoleModelsForProviders,
  getProviderValues,
  hasUsableProviderDrafts,
  providerDraftsFromStoredProviders,
  roleModelsFromOverrideModels,
  serializeOverrideModels,
  isProviderValue,
  PROVIDER_LABELS,
} from "@/components/ai-config-role-models.logic";
import type {
  ModelSelection,
  ProviderCredentialDraft,
  RoleModelSelections,
  RoleValue,
} from "@/components/ai-config-role-models.logic";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import {
  aiConfigKeys,
  aiConfigOptions,
} from "@/routes/_protected.organization/-ai-config-queries";

export const AIConfigCard = () => {
  const t = useTranslations("organization");
  const tCommon = useTranslations("common");
  const tSuccess = useTranslations("success");
  const tErrors = useTranslations("errors");
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  const activeOrganizationId = useRouteContext({
    from: "/_protected",
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const { data: config } = useQuery(
    aiConfigOptions({ organizationId: activeOrganizationId }),
  );

  const initialProviders =
    config?.configured && config.providers.length > 0
      ? providerDraftsFromStoredProviders(config.providers)
      : [createProviderCredentialDraft()];
  const initialProviderValues = getProviderValues(initialProviders);
  const initialRoleModels = config?.configured
    ? roleModelsFromOverrideModels({
        overrideModels: config.overrideModels,
        providers: initialProviderValues,
      })
    : createDefaultRoleModels(initialProviderValues);

  const [providers, setProviders] =
    useState<ProviderCredentialDraft[]>(initialProviders);
  const [roleModels, setRoleModels] =
    useState<RoleModelSelections>(initialRoleModels);

  // Sync form state when the config query resolves after
  // initial render (useState initializers only run once).
  // Intentionally depends only on `configured` to avoid
  // overwriting user edits on query refetch.
  useEffect(() => {
    if (!config?.configured) {
      return;
    }
    const nextProviders = providerDraftsFromStoredProviders(config.providers);
    const providerValues = getProviderValues(nextProviders);
    setProviders(nextProviders);
    setRoleModels(
      roleModelsFromOverrideModels({
        overrideModels: config.overrideModels,
        providers: providerValues,
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally depends only on `configured` (see comment above); the full `config` identity would overwrite user edits on every refetch.
  }, [config?.configured]);

  const updateProviders = (nextProviders: ProviderCredentialDraft[]) => {
    const providerValues = getProviderValues(nextProviders);
    setProviders(nextProviders);
    setRoleModels((prev) =>
      ensureRoleModelsForProviders({
        providers: providerValues,
        roleModels: prev,
      }),
    );
  };

  const setRoleModel = (role: RoleValue, model: ModelSelection | null) => {
    setRoleModels((prev) => ({
      ...prev,
      [role]: model,
    }));
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      const providerValues = getProviderValues(providers);
      const overrideModels = serializeOverrideModels({
        providers: providerValues,
        roleModels,
      });
      if (!overrideModels) {
        throw new Error(t("aiConfig.selectModelForEachRole"));
      }

      const response = await api["organization-settings"]["ai-config"].post({
        providers: providers.map((providerDraft) => ({
          provider: providerDraft.provider,
          ...(providerDraft.apiKey.trim()
            ? { apiKey: providerDraft.apiKey.trim() }
            : {}),
          ...(providerDraft.provider === "azure_foundry"
            ? {
                endpoint: providerDraft.endpoint.trim(),
                ...(providerDraft.apiVersion
                  ? { apiVersion: providerDraft.apiVersion }
                  : {}),
              }
            : {}),
          region: providerDraft.region,
        })),
        overrideModels,
      });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    onSuccess: async (data) => {
      setProviders(providerDraftsFromStoredProviders(data.providers));
      queryClient.setQueryData(
        aiConfigKeys.availability({ organizationId: activeOrganizationId }),
        {
          available: true,
          instanceProvisioned: config?.instanceProvisioned ?? false,
          orgConfigured: true,
        },
      );
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: aiConfigKeys.byOrganization({
            organizationId: activeOrganizationId,
          }),
        }),
        queryClient.invalidateQueries({
          queryKey: aiConfigKeys.availability({
            organizationId: activeOrganizationId,
          }),
        }),
      ]);
      stellaToast.add({
        title: tSuccess("aiConfigUpdated"),
        type: "success",
      });
    },
    onError: (error) => {
      analytics.captureError(error);
      stellaToast.add({
        title: error instanceof Error ? error.message : tErrors("actionFailed"),
        type: "error",
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      const response = await api["organization-settings"]["ai-config"].delete(
        {},
      );
      if (response.error) {
        throw toAPIError(response.error);
      }
    },
    onSuccess: async () => {
      const nextProviders = [createProviderCredentialDraft()];
      setProviders(nextProviders);
      setRoleModels(createDefaultRoleModels(getProviderValues(nextProviders)));
      queryClient.setQueryData(
        aiConfigKeys.availability({ organizationId: activeOrganizationId }),
        {
          available: config?.instanceProvisioned ?? false,
          instanceProvisioned: config?.instanceProvisioned ?? false,
          orgConfigured: false,
        },
      );
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: aiConfigKeys.byOrganization({
            organizationId: activeOrganizationId,
          }),
        }),
        queryClient.invalidateQueries({
          queryKey: aiConfigKeys.availability({
            organizationId: activeOrganizationId,
          }),
        }),
      ]);
      stellaToast.add({
        title: tSuccess("aiConfigDeleted"),
        type: "success",
      });
    },
    onError: (error) => {
      analytics.captureError(error);
      stellaToast.add({
        title: tErrors("actionFailed"),
        type: "error",
      });
    },
  });

  const providerValues = getProviderValues(providers);
  const canSave =
    hasUsableProviderDrafts(providers) &&
    serializeOverrideModels({ providers: providerValues, roleModels }) !== null;

  return (
    <div className="flex flex-col gap-4">
      {config?.configured && (
        <div className="flex items-center justify-between gap-2">
          <div className="bg-muted flex flex-wrap items-center gap-2 rounded border px-3 py-2">
            <span className="text-muted-foreground text-xs">
              {t("aiConfig.active")}:
            </span>
            {config.providers.map((providerConfig) => (
              <span
                className="text-xs"
                key={`${providerConfig.provider}-${providerConfig.apiKeyMasked}`}
              >
                <span className="font-medium">
                  {isProviderValue(providerConfig.provider)
                    ? PROVIDER_LABELS[providerConfig.provider]
                    : providerConfig.provider}
                </span>{" "}
                <span className="text-muted-foreground font-mono">
                  {providerConfig.apiKeyMasked}
                </span>
              </span>
            ))}
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
          <div className="flex flex-col gap-5 p-1">
            <AIConfigProvidersEditor
              disabled={saveMutation.isPending}
              onProvidersChange={updateProviders}
              providers={providers}
            />

            <div className="border-t" />

            <AIConfigRoleModelPicker
              disabled={saveMutation.isPending}
              onModelChange={setRoleModel}
              providers={providerValues}
              roleModels={roleModels}
            />
          </div>
        </FramePanel>
      </Frame>

      {!canSave && (
        <p className="text-destructive-foreground text-xs">
          {t("aiConfig.selectModelForEachRole")}
        </p>
      )}

      <Button
        className="self-start"
        disabled={!canSave}
        loading={saveMutation.isPending}
        onClick={() => saveMutation.mutate()}
        size="sm"
      >
        {config?.configured ? tCommon("saveChanges") : t("aiConfig.configure")}
      </Button>
    </div>
  );
};
