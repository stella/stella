import type { PropsWithChildren } from "react";
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/components/dialog";
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
  serializeProviderDrafts,
} from "@/components/ai-config-role-models.logic";
import type {
  ModelSelection,
  ProviderCredentialDraft,
  RoleModelSelections,
  RoleValue,
} from "@/components/ai-config-role-models.logic";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { toAPIError } from "@/lib/errors";
import {
  aiAvailabilityOptions,
  aiConfigOptions,
  aiConfigKeys,
} from "@/routes/_protected.organization/-ai-config-queries";

type AIAvailabilityContextValue = {
  ensureAIAvailable: () => Promise<boolean>;
  openAIKeyDialog: () => void;
  openIfAIUnavailable: () => void;
};

const AIAvailabilityContext = createContext<AIAvailabilityContextValue | null>(
  null,
);

export function AIAvailabilityProvider({ children }: PropsWithChildren) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const activeOrganizationId = useAuthenticatedUser().activeOrganizationId;
  const availabilityOptions = useMemo(
    () => aiAvailabilityOptions({ organizationId: activeOrganizationId }),
    [activeOrganizationId],
  );
  const { data, isFetching } = useQuery(availabilityOptions);

  const openAIKeyDialog = useCallback(() => {
    setOpen(true);
  }, []);

  const ensureAIAvailable = useCallback(async () => {
    const availability = await queryClient
      .fetchQuery(availabilityOptions)
      .catch(() => undefined);

    if (availability?.available) {
      return true;
    }

    setOpen(true);
    return false;
  }, [availabilityOptions, queryClient]);

  const openIfAIUnavailable = useCallback(() => {
    if (data && !data.available && !isFetching) {
      setOpen(true);
    }
  }, [data, isFetching]);

  useEffect(() => {
    if (data?.available) {
      setOpen(false);
    }
  }, [data?.available]);

  const value = useMemo(
    () => ({
      ensureAIAvailable,
      openAIKeyDialog,
      openIfAIUnavailable,
    }),
    [ensureAIAvailable, openAIKeyDialog, openIfAIUnavailable],
  );

  return (
    <AIAvailabilityContext value={value}>
      {children}
      <AIKeyRequiredDialog onOpenChange={setOpen} open={open} />
    </AIAvailabilityContext>
  );
}

export const useAIKeyGate = () => {
  const context = use(AIAvailabilityContext);

  if (!context) {
    panic("useAIKeyGate must be used within AIAvailabilityProvider");
  }

  return context;
};

/**
 * Whether AI features are available right now: either the org has
 * BYOK or the instance has provisioned keys.
 */
export function useAIAvailable(): boolean {
  const activeOrganizationId = useAuthenticatedUser().activeOrganizationId;
  const { data, isError } = useQuery(
    aiAvailabilityOptions({ organizationId: activeOrganizationId }),
  );
  if (isError || data === undefined) {
    return false;
  }
  return data.available;
}

/**
 * Gate AI routes when the instance has no provisioned keys and
 * the org has not supplied their own. Send-time surfaces should
 * use `useAIKeyGate()` so every AI action opens the same dialog.
 */
export function RequireAIKey({ children }: PropsWithChildren) {
  const t = useTranslations();
  const activeOrganizationId = useAuthenticatedUser().activeOrganizationId;
  const { data, isFetching, isPending, isError } = useQuery(
    aiAvailabilityOptions({ organizationId: activeOrganizationId }),
  );
  const { openAIKeyDialog, openIfAIUnavailable } = useAIKeyGate();

  useEffect(() => {
    openIfAIUnavailable();
  }, [openIfAIUnavailable]);

  if (isPending || (isFetching && data?.available === false)) {
    return null;
  }

  if (!isError && data.available) {
    return <>{children}</>;
  }

  return (
    <div className="flex h-full w-full flex-1 items-center justify-center p-6">
      <div className="border-border bg-card text-card-foreground flex max-w-md flex-col gap-4 rounded-lg border p-6 shadow-sm">
        <div className="flex flex-col gap-1">
          <h2 className="text-foreground text-lg font-semibold">
            {t("ai.keyRequired.title")}
          </h2>
          <p className="text-muted-foreground text-sm">
            {t("ai.keyRequired.description")}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={openAIKeyDialog}>{t("ai.keyRequired.cta")}</Button>
          <Button
            render={<Link to="/settings/organization/ai" />}
            variant="ghost"
          >
            {t("organization.aiConfig.title")}
          </Button>
        </div>
      </div>
    </div>
  );
}

type AIKeyRequiredDialogProps = {
  onOpenChange: (open: boolean) => void;
  open: boolean;
};

export function AIKeyRequiredDialog({
  onOpenChange,
  open,
}: AIKeyRequiredDialogProps) {
  const t = useTranslations();
  const tCommon = useTranslations("common");
  const tOrganization = useTranslations("organization");
  const tErrors = useTranslations("errors");
  const tSuccess = useTranslations("success");
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  const activeOrganizationId = useAuthenticatedUser().activeOrganizationId;
  const { data: config } = useQuery(
    aiConfigOptions({ organizationId: activeOrganizationId }),
  );
  const [providers, setProviders] = useState<ProviderCredentialDraft[]>(() => [
    createProviderCredentialDraft(),
  ]);
  const [roleModels, setRoleModels] = useState<RoleModelSelections>(
    createDefaultRoleModels,
  );

  useEffect(() => {
    if (!open) {
      return;
    }

    if (!config?.configured) {
      const nextProviders = [createProviderCredentialDraft()];
      setProviders(nextProviders);
      setRoleModels(createDefaultRoleModels(getProviderValues(nextProviders)));
      return;
    }

    const nextProviders = providerDraftsFromStoredProviders(
      config.providers,
    ).slice(0, 1);
    const providerValues = getProviderValues(nextProviders);
    setProviders(nextProviders);
    setRoleModels(
      roleModelsFromOverrideModels({
        overrideModels: config.overrideModels,
        providers: providerValues,
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally re-syncs only when the dialog opens or `configured` flips; depending on the full `config` identity would overwrite user edits on every refetch.
  }, [open, config?.configured]);

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
        // The Configure button is disabled when `canSave` is false, which
        // checks the same `serializeOverrideModels(...) !== null` invariant.
        // The inline message at the field below renders the translated text.
        panic("ai-config save fired with no valid override models");
      }

      const response = await api["organization-settings"]["ai-config"].post({
        providers: serializeProviderDrafts(providers),
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
      onOpenChange(false);
    },
    onError: (error) => {
      analytics.captureError(error);
      stellaToast.add({
        title: error instanceof Error ? error.message : tErrors("actionFailed"),
        type: "error",
      });
    },
  });

  const providerValues = getProviderValues(providers);
  const canSave =
    hasUsableProviderDrafts(providers) &&
    serializeOverrideModels({ providers: providerValues, roleModels }) !== null;

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogPopup className="max-h-[calc(100dvh-2rem)] overflow-hidden sm:max-w-3xl">
        <DialogHeader className="p-4 pb-2">
          <DialogTitle>{t("ai.keyRequired.title")}</DialogTitle>
          <DialogDescription>
            {t("ai.keyRequired.description")}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 overflow-x-hidden overflow-y-auto px-4 pb-3">
          <div className="grid gap-3">
            <AIConfigProvidersEditor
              compact
              disabled={saveMutation.isPending}
              onProvidersChange={updateProviders}
              providers={providers}
            />

            <AIConfigRoleModelPicker
              compact
              disabled={saveMutation.isPending}
              onModelChange={setRoleModel}
              providers={providerValues}
              roleModels={roleModels}
            />

            {!canSave && (
              <p className="text-destructive-foreground text-xs">
                {tOrganization("aiConfig.selectModelForEachRole")}
              </p>
            )}
          </div>
        </div>
        <DialogFooter className="px-4 py-3">
          <DialogClose render={<Button variant="ghost" />}>
            {tCommon("cancel")}
          </DialogClose>
          <Button
            disabled={!canSave}
            loading={saveMutation.isPending}
            onClick={() => saveMutation.mutate()}
          >
            {tOrganization("aiConfig.configure")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
