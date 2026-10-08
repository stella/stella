import { useState } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { panic, Result } from "better-result";
import { useTranslations } from "use-intl";

import {
  AlertDialog,
  AlertDialogPopup,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogClose,
} from "@stll/ui/alert-dialog";
import { Button } from "@stll/ui/button";
import { Trash2Icon } from "@stll/ui/icons";
import { stellaToast } from "@stll/ui/toast";

import {
  createProviderCredentialDraft,
  getProviderValues,
  hasProviderCredentialChanges,
  hasUsableDecisionModel,
  providerDraftsFromStoredProviders,
  serializeDecisionModel,
  serializeRoleOverrides,
  roleOverridesFromStoredModels,
  retainRoleOverridesForProviders,
  serializeProviderDrafts,
} from "@/components/ai-config-role-models.logic";
import type {
  DecisionModelState,
  ProviderCredentialDraft,
  RoleModelOverrides,
  StoredDecisionModel,
} from "@/components/ai-config-role-models.logic";
import { useUnsavedWork } from "@/hooks/use-unsaved-work";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { detached } from "@/lib/detached";
import { APIError, toAPIError, unwrapEden } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import { invalidateAIConfigurationCaches } from "@/lib/organization/ai-config-cache";
import {
  aiAvailabilityOptions,
  aiConfigOptions,
  updateCachedAIAvailability,
} from "@/lib/organization/ai-config-queries";
import type { OrganizationAIConfig } from "@/lib/organization/ai-config-queries";
import { AIProviderRows } from "@/routes/_protected.settings/-components/organization/ai-provider-rows";

import { AIConfigAdvanced } from "./ai-config-advanced";

export const AIConfigCard = () => {
  const activeOrganizationId = useRouteContext({
    from: "/_protected",
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const {
    data: config,
    isError,
    refetch,
  } = useQuery(aiConfigOptions({ organizationId: activeOrganizationId }));

  // The read fails closed when the stored config cannot be decrypted, and the
  // form below is the only place the stored config can be removed. Rendering
  // nothing would strand an administrator with no way back, so the failure gets
  // its own state carrying the same remove action.
  if (isError) {
    return (
      <AIConfigUnreadable
        onRetry={() => {
          detached(refetch(), "ai-config-card.refetch");
        }}
        organizationId={activeOrganizationId}
      />
    );
  }

  if (!config) {
    return null;
  }

  return (
    <AIConfigForm
      config={config}
      key={activeOrganizationId}
      organizationId={activeOrganizationId}
    />
  );
};

type AIConfigUnreadableProps = {
  onRetry: () => void;
  organizationId: string;
};

const AIConfigUnreadable = ({
  onRetry,
  organizationId,
}: AIConfigUnreadableProps) => {
  const tCommon = useTranslations("common");
  const tErrors = useTranslations("errors");
  const tSuccess = useTranslations("success");
  const analytics = useAnalytics();
  const queryClient = useQueryClient();

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
      await invalidateAIConfigurationCaches(queryClient, organizationId);
      stellaToast.add({
        title: tSuccess("aiConfigDeleted"),
        type: "success",
      });
    },
    onError: (error) => {
      analytics.captureError(error);
      notifyUserError(error, tErrors("actionFailed"));
    },
  });

  return (
    <div className="flex items-center justify-between gap-3 py-4">
      <p className="text-destructive text-sm">
        {tCommon("somethingWentWrong")}
      </p>
      <div className="flex items-center gap-2">
        <Button onClick={onRetry} size="sm" variant="outline">
          {tCommon("retry")}
        </Button>
        <Button
          loading={deleteMutation.isPending}
          onClick={() => deleteMutation.mutate()}
          size="sm"
          variant="ghost"
        >
          <Trash2Icon className="size-4" />
          {tCommon("remove")}
        </Button>
      </div>
    </div>
  );
};

type AIConfigFormProps = {
  config: OrganizationAIConfig;
  organizationId: string;
};

type PersistAIConfigOptions = {
  nextProviders: ProviderCredentialDraft[];
  nextRoles: RoleModelOverrides;
  mode: "credentials" | "settings";
};

export const AIConfigForm = ({ config, organizationId }: AIConfigFormProps) => {
  const t = useTranslations("organization");
  const common = useTranslations("common");
  const queryClient = useQueryClient();
  const initialProviders = config.configured
    ? providerDraftsFromStoredProviders(config.providers)
    : [];
  const [storedProviders, setStoredProviders] = useState(initialProviders);
  const [providers, setProviders] = useState(
    config.configured ? initialProviders : [createProviderCredentialDraft()],
  );
  const initialRoles = config.configured
    ? roleOverridesFromStoredModels({
        overrideModels: config.overrideModels,
        providers: getProviderValues(initialProviders),
      })
    : {};
  const [roleModels, setRoleModels] = useState(initialRoles);
  const [savedRoles, setSavedRoles] = useState(initialRoles);
  const [decisionState, setDecisionState] = useState<DecisionModelState>({
    kind: "untouched",
  });
  const [storedDecision, setStoredDecision] =
    useState<StoredDecisionModel | null>(
      config.configured ? config.decision : null,
    );
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving">("idle");
  const isDirty =
    providers.some((draft) =>
      hasProviderCredentialChanges({
        draft,
        stored: storedProviders.find(
          (saved) => saved.provider === draft.provider,
        ),
      }),
    ) ||
    decisionState.kind !== "untouched" ||
    JSON.stringify(roleModels) !== JSON.stringify(savedRoles);
  const blocker = useUnsavedWork({
    surface: "ai-provider-settings",
    guard: "confirm-navigation",
    isDirty,
  });

  const refresh = async (configured: boolean) => {
    queryClient.setQueryData(
      aiAvailabilityOptions({ organizationId }).queryKey,
      (current) =>
        updateCachedAIAvailability({
          current,
          instanceProvisioned: config.instanceProvisioned,
          orgConfigured: configured,
        }),
    );
    await invalidateAIConfigurationCaches(queryClient, organizationId);
  };

  const persist = async ({
    nextProviders,
    nextRoles,
    mode,
  }: PersistAIConfigOptions) => {
    const serialized = serializeRoleOverrides({
      providers: getProviderValues(nextProviders),
      overrides: nextRoles,
    });
    if (mode === "settings" && serialized.kind === "invalid") {
      const error = new APIError({
        code: "ai_config_model_invalid",
        status: 400,
        message: t("aiConfig.selectModelForEachRole"),
      });
      throw error;
    }
    const decision =
      mode === "settings" ? serializeDecisionModel(decisionState) : undefined;
    const response = await api["organization-settings"]["ai-config"].post({
      providers: serializeProviderDrafts(nextProviders),
      ...(mode === "settings" && serialized.kind === "valid"
        ? { overrideModels: serialized.overrides }
        : {}),
      ...(decision === undefined ? {} : { decision }),
    });
    const data = unwrapEden(response);
    const saved = providerDraftsFromStoredProviders(data.providers);
    setStoredProviders(saved);
    const savedOverrides = roleOverridesFromStoredModels({
      overrideModels: data.overrideModels,
      providers: getProviderValues(saved),
    });
    setRoleModels((current) =>
      mode === "settings"
        ? savedOverrides
        : retainRoleOverridesForProviders({
            providers: getProviderValues(saved),
            overrides: current,
          }),
    );
    setSavedRoles(savedOverrides);
    setStoredDecision(data.decision);
    if (mode === "settings") {
      setDecisionState({ kind: "untouched" });
    }
    await refresh(true);
    return saved;
  };

  const saveProvider = async (draft: ProviderCredentialDraft) => {
    setSaveState("saving");
    const result = await Result.tryPromise({
      try: async () => {
        // Provider order determines the effective model for default roles.
        const next = storedProviders.some(
          (provider) => provider.provider === draft.provider,
        )
          ? storedProviders.map((provider) =>
              provider.provider === draft.provider ? draft : provider,
            )
          : [...storedProviders, draft];
        const nextRoles = savedRoles;
        const saved = await persist({
          nextProviders: next,
          nextRoles,
          mode: "credentials",
        });
        setProviders((current) =>
          current.map((provider) =>
            provider.provider === draft.provider
              ? (saved.find(
                  (candidate) => candidate.provider === draft.provider,
                ) ?? panic("Saved provider absent"))
              : provider,
          ),
        );
      },
      catch: (error: unknown) => error,
    });
    setSaveState("idle");
    if (result.isErr()) {
      throw result.error;
    }
  };

  const removeProvider = async (draft: ProviderCredentialDraft) => {
    if (
      !storedProviders.some((provider) => provider.provider === draft.provider)
    ) {
      setProviders((current) =>
        current.filter((provider) => provider.provider !== draft.provider),
      );
      return;
    }
    setSaveState("saving");
    const result = await Result.tryPromise({
      try: async () => {
        const next = storedProviders.filter(
          (provider) => provider.provider !== draft.provider,
        );
        if (next.length === 0) {
          unwrapEden(
            await api["organization-settings"]["ai-config"].delete({}),
          );
          setStoredProviders([]);
          setRoleModels({});
          setSavedRoles({});
          setStoredDecision(null);
          setDecisionState({ kind: "untouched" });
          await refresh(false);
        } else {
          await persist({
            nextProviders: next,
            nextRoles: savedRoles,
            mode: "credentials",
          });
        }
        setProviders((current) =>
          current.filter((provider) => provider.provider !== draft.provider),
        );
      },
      catch: (error: unknown) => error,
    });
    setSaveState("idle");
    if (result.isErr()) {
      throw result.error;
    }
  };

  const saveSettings = async () => {
    setSaveState("saving");
    setSettingsError(null);
    const result = await Result.tryPromise({
      try: async () =>
        await persist({
          nextProviders: storedProviders,
          nextRoles: roleModels,
          mode: "settings",
        }),
      catch: (error: unknown) => error,
    });
    if (result.isErr()) {
      const error = result.error;
      setSettingsError(
        APIError.is(error)
          ? (error.rawMessage ?? error.message)
          : common("somethingWentWrong"),
      );
    }
    setSaveState("idle");
  };
  const providerValues = getProviderValues(storedProviders);
  const canSaveSettings =
    storedProviders.length > 0 &&
    serializeRoleOverrides({ providers: providerValues, overrides: roleModels })
      .kind === "valid" &&
    hasUsableDecisionModel({ state: decisionState, stored: storedDecision });
  return (
    <div className="flex flex-col gap-4">
      <AIProviderRows
        storedProviders={storedProviders}
        providers={providers}
        disabled={saveState === "saving"}
        onChange={setProviders}
        onSave={saveProvider}
        onRemove={removeProvider}
      />
      {storedProviders.length > 0 && (
        <AIConfigAdvanced
          disabled={saveState === "saving"}
          providers={providerValues}
          roleModels={roleModels}
          onRoleChange={(role, model) =>
            setRoleModels((previous) => ({ ...previous, [role]: model }))
          }
          onRoleReset={(role) =>
            setRoleModels((previous) =>
              Object.fromEntries(
                Object.entries(previous).filter(([key]) => key !== role),
              ),
            )
          }
          decisionState={decisionState}
          storedDecision={storedDecision}
          onDecisionChange={setDecisionState}
          decisionInstanceProvisioned={config.decisionInstanceProvisioned}
          canSave={canSaveSettings}
          onSave={() => detached(saveSettings(), "ai-config.save-settings")}
          settingsError={settingsError}
          custom={Object.keys(savedRoles).length > 0 || storedDecision !== null}
        />
      )}
      <AlertDialog
        open={blocker.status === "blocked"}
        onOpenChange={(open) => {
          if (!open && blocker.status === "blocked") {
            blocker.reset();
          }
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{common("confirmAction")}</AlertDialogTitle>
            <AlertDialogDescription>
              {common("unsavedLeaveConfirm")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>
              {common("goBackToEditing")}
            </AlertDialogClose>
            <Button
              onClick={() => {
                if (blocker.status === "blocked") {
                  blocker.proceed();
                }
              }}
            >
              {common("confirm")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
};
