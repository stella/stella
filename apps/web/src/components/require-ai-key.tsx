import type { PropsWithChildren } from "react";
import { createContext, use, useCallback, useMemo, useState } from "react";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  Dialog,
  DialogFormState,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/dialog";
import { LoaderState } from "@stll/ui/loader";
import { stellaToast } from "@stll/ui/toast";

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
import { QueryViewFeedback } from "@/components/query-view-feedback";
import { useChromeQuery } from "@/hooks/use-chrome-query";
import { useMountEffect } from "@/hooks/use-effect";
import { getAnalytics, useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { unwrapEden } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import { invalidateAIConfigurationCaches } from "@/lib/organization/ai-config-cache";
import {
  aiAvailabilityOptions,
  aiConfigOptions,
  updateCachedAIAvailability,
} from "@/lib/organization/ai-config-queries";
import { useQueryView, useQueryViewError } from "@/lib/use-query-view";

type AIAvailabilityContextValue = {
  ensureAIAvailable: () => Promise<boolean>;
  openAIKeyDialog: () => void;
  openIfAIUnavailable: () => void;
};

const AIAvailabilityContext = createContext<AIAvailabilityContextValue | null>(
  null,
);
const AIUnavailableContext = createContext(false);

/**
 * Provides the AI key gate. Idempotent: under an existing provider it renders
 * its children as they are, so a surface that needs the gate can mount one
 * itself without a second availability read or a second dialog. Every surface
 * that calls `useAIKeyGate` must be able to reach one from any route it can be
 * rendered on, the public law readers and their inspector views included.
 */
export const AIAvailabilityProvider = ({
  children,
}: PropsWithChildren): React.ReactNode => {
  const outer = use(AIAvailabilityContext);
  if (outer !== null) {
    return children;
  }
  return <AIAvailabilityRoot>{children}</AIAvailabilityRoot>;
};

const AIAvailabilityRoot = ({ children }: PropsWithChildren) => {
  const [open, setOpen] = useState(false);
  const tErrors = useTranslations("errors");
  const queryClient = useQueryClient();
  const activeOrganizationId = useAuthenticatedUser().activeOrganizationId;
  const availabilityOptions = useMemo(
    () => aiAvailabilityOptions({ organizationId: activeOrganizationId }),
    [activeOrganizationId],
  );
  const dataQuery = useChromeQuery(availabilityOptions);
  const dataView = useQueryView(dataQuery);
  useQueryViewError(dataView);
  const { isFetching } = dataQuery;
  const data = dataView.type === "items" ? dataView.items : undefined;

  const openAIKeyDialog = useCallback(() => {
    setOpen(true);
  }, []);

  const ensureAIAvailable = useCallback(async () => {
    const availability = await queryClient
      .query(availabilityOptions)
      .catch((error: unknown) => {
        getAnalytics().captureError(error);
        // Callers read `false` as "do not proceed" and stop there, so without
        // this the action the user just triggered would appear to do nothing.
        notifyUserError(error, tErrors("actionFailed"));
        return null;
      });

    // A failed availability check is not evidence that no key is configured,
    // so it must not open the configure-key dialog.
    if (availability === null) {
      return false;
    }

    if (availability.available) {
      return true;
    }

    setOpen(true);
    return false;
  }, [availabilityOptions, queryClient, tErrors]);

  const openIfAIUnavailable = useCallback(() => {
    if (
      dataQuery.status === "success" &&
      data &&
      !data.available &&
      !isFetching
    ) {
      setOpen(true);
    }
  }, [data, dataQuery.status, isFetching]);
  const aiUnavailable = Boolean(
    dataQuery.status === "success" && data && !data.available && !isFetching,
  );

  // Force-close the dialog whenever the availability query flips to available
  // (e.g. keys configured elsewhere and refetched). Adjust-state-during-render on
  // the availability transition rather than in an effect; `open` stays
  // independent user-controlled state the rest of the time.
  const [prevAvailable, setPrevAvailable] = useState(data?.available);
  if (data?.available !== prevAvailable) {
    setPrevAvailable(data?.available);
    if (data?.available) {
      setOpen(false);
    }
  }

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
      <AIUnavailableContext value={aiUnavailable}>
        {children}
        <AIKeyRequiredDialog onOpenChange={setOpen} open={open} />
      </AIUnavailableContext>
    </AIAvailabilityContext>
  );
};

export const useAIKeyGate = () => {
  const context = use(AIAvailabilityContext);

  if (!context) {
    panic("useAIKeyGate must be used within AIAvailabilityProvider");
  }

  return context;
};

const OpenAIKeyDialogOnMount = ({ open }: { open: () => void }) => {
  useMountEffect(() => {
    open();
  });
  return null;
};

export const AIUnavailableDialogTrigger = () => {
  const aiUnavailable = use(AIUnavailableContext);
  const { openAIKeyDialog } = useAIKeyGate();
  if (!aiUnavailable) {
    return null;
  }
  return <OpenAIKeyDialogOnMount open={openAIKeyDialog} />;
};

/**
 * Gate AI routes when the instance has no provisioned keys and
 * the org has not supplied their own. Send-time surfaces should
 * use `useAIKeyGate()` so every AI action opens the same dialog.
 */
// Explicit ReactNode: returning bare `children` infers a type containing
// React 19's Promise<AwaitedReactNode> member, which promise-function-async
// would otherwise flag on this intentionally sync component.
export const RequireAIKey = ({
  children,
}: PropsWithChildren): React.ReactNode => {
  const t = useTranslations();
  const activeOrganizationId = useAuthenticatedUser().activeOrganizationId;
  const dataQuery = useChromeQuery(
    aiAvailabilityOptions({ organizationId: activeOrganizationId }),
  );
  const dataView = useQueryView(dataQuery);
  useQueryViewError(dataView);
  const { isFetching, isPending } = dataQuery;
  const data = dataView.type === "items" ? dataView.items : undefined;
  const { openAIKeyDialog } = useAIKeyGate();

  if (isPending) {
    return <QueryViewFeedback view={dataView} />;
  }
  if (isFetching && data?.available === false) {
    return <LoaderState label={t("common.loading")} />;
  }

  if (
    dataView.type === "error" ||
    (dataView.type === "items" && dataView.refetchError !== undefined)
  ) {
    return <QueryViewFeedback view={dataView} />;
  }

  if (data?.available) {
    return children;
  }

  return (
    <div className="flex h-full w-full flex-1 items-center justify-center p-6">
      <AIUnavailableDialogTrigger />
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
};

type AIKeyRequiredDialogProps = {
  onOpenChange: (open: boolean) => void;
  open: boolean;
};

// A fresh, empty provider draft. No dependency on props/state, so it's built
// once at module scope instead of on every render/dialog-open.
const DEFAULT_PROVIDER_DRAFTS: ProviderCredentialDraft[] = [
  createProviderCredentialDraft(),
];

export const AIKeyRequiredDialog = ({
  onOpenChange,
  open,
}: AIKeyRequiredDialogProps) => {
  const t = useTranslations();
  const tCommon = useTranslations("common");
  const tOrganization = useTranslations("organization");
  const tErrors = useTranslations("errors");
  const tSuccess = useTranslations("success");
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  const activeOrganizationId = useAuthenticatedUser().activeOrganizationId;
  const configQuery = useChromeQuery({
    ...aiConfigOptions({ organizationId: activeOrganizationId }),
    enabled: open,
  });
  const configView = useQueryView(configQuery);
  useQueryViewError(configView);
  const config = configView.type === "items" ? configView.items : undefined;
  const [providers, setProviders] = useState<ProviderCredentialDraft[]>(
    DEFAULT_PROVIDER_DRAFTS,
  );
  const [roleModels, setRoleModels] = useState<RoleModelSelections>(
    createDefaultRoleModels,
  );

  const [initialProviders, setInitialProviders] = useState(
    DEFAULT_PROVIDER_DRAFTS,
  );
  const [initialRoleModels, setInitialRoleModels] = useState(
    createDefaultRoleModels,
  );

  // Re-syncs the provider/role-model form drafts from `config` when the
  // dialog opens (or when `configured` flips while it's open), deliberately
  // ignoring later `config` refetches so user edits survive. Storing
  // `lastOpen`/`lastConfigured` from the previous render and comparing
  // during render (rather than an effect) mirrors the exact dependency set
  // the effect used to react to; the inequality guard makes the render-time
  // setState calls loop-safe. A key-based remount cannot replace this
  // because the dialog is rendered in more than one place and remounting
  // would also reset mutation state and re-suspend the config query.
  const [lastOpen, setLastOpen] = useState(open);
  const [lastConfigured, setLastConfigured] = useState(config?.configured);
  if (open !== lastOpen || config?.configured !== lastConfigured) {
    setLastOpen(open);
    setLastConfigured(config?.configured);

    if (open) {
      if (config?.configured) {
        const nextProviders = providerDraftsFromStoredProviders(
          config.providers,
        ).slice(0, 1);
        const providerValues = getProviderValues(nextProviders);
        setProviders(nextProviders);
        setInitialProviders(nextProviders);
        setInitialRoleModels(
          roleModelsFromOverrideModels({
            overrideModels: config.overrideModels,
            providers: providerValues,
          }),
        );
        setRoleModels(
          roleModelsFromOverrideModels({
            overrideModels: config.overrideModels,
            providers: providerValues,
          }),
        );
      } else {
        const nextProviders = DEFAULT_PROVIDER_DRAFTS;
        setProviders(nextProviders);
        setInitialProviders(nextProviders);
        setInitialRoleModels(
          createDefaultRoleModels(getProviderValues(nextProviders)),
        );
        setRoleModels(
          createDefaultRoleModels(getProviderValues(nextProviders)),
        );
      }
    }
  }

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

      return unwrapEden(response);
    },
    onSuccess: async (data) => {
      setProviders(providerDraftsFromStoredProviders(data.providers));
      queryClient.setQueryData(
        aiAvailabilityOptions({ organizationId: activeOrganizationId })
          .queryKey,
        (current) =>
          updateCachedAIAvailability({
            current,
            ...(config === undefined
              ? {}
              : { instanceProvisioned: config.instanceProvisioned }),
            orgConfigured: true,
          }),
      );
      await invalidateAIConfigurationCaches(queryClient, activeOrganizationId);
      stellaToast.add({
        title: tSuccess("aiConfigUpdated"),
        type: "success",
      });
      onOpenChange(false);
    },
    onError: (error) => {
      analytics.captureError(error);
      notifyUserError(error, tErrors("actionFailed"));
    },
  });

  const providerValues = getProviderValues(providers);
  const canSave =
    configQuery.status === "success" &&
    hasUsableProviderDrafts(providers) &&
    serializeOverrideModels({ providers: providerValues, roleModels }) !== null;

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogPopup className="max-h-[calc(100dvh-2rem)] overflow-hidden sm:max-w-3xl">
        <DialogFormState
          dirty={
            JSON.stringify(providers) !== JSON.stringify(initialProviders) ||
            JSON.stringify(roleModels) !== JSON.stringify(initialRoleModels)
          }
          onDiscard={() => {
            setProviders(initialProviders);
            setRoleModels(initialRoleModels);
          }}
        />
        <DialogHeader className="p-4 pb-2">
          <DialogTitle>{t("ai.keyRequired.title")}</DialogTitle>
          <DialogDescription>
            {t("ai.keyRequired.description")}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 overflow-x-hidden overflow-y-auto px-4 pb-3">
          <QueryViewFeedback view={configView} />
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
};
