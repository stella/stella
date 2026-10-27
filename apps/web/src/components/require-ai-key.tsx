import type { PropsWithChildren } from "react";
import { createContext, use, useCallback, useMemo, useState } from "react";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import type { OrganizationAIAvailability } from "@stll/api-contract/organization-ai-availability";
import { resolveAIProviderSettings } from "@stll/api-contract/organization-ai-availability";
import { Button } from "@stll/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogFormState,
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
  getProviderValues,
  hasUsableProviderDrafts,
  haveSameRoleModelSelections,
  projectDefaultRoleModels,
  projectProviderDefaultRoleModels,
  providerDraftsFromStoredProviders,
  retainRoleOverridesForProviders,
  roleModelsFromOverrideModels,
  roleOverridesFromStoredModels,
  serializeProviderDrafts,
  serializeRoleOverrides,
} from "@/components/ai-config-role-models.logic";
import type {
  ModelSelection,
  ProviderCredentialDraft,
  RoleModelOverrides,
  RoleValue,
} from "@/components/ai-config-role-models.logic";
import { QueryViewFeedback } from "@/components/query-view-feedback";
import { useRequiredRouteProvider } from "@/components/route-provider-scope/route-provider-scope";
import { useChromeQuery } from "@/hooks/use-chrome-query";
import { useMountEffect } from "@/hooks/use-effect";
import { getAnalytics, useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { APIError, unwrapApiResponse } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import { invalidateAIConfigurationCaches } from "@/lib/organization/ai-config-cache";
import {
  aiAvailabilityOptions,
  aiConfigOptions,
  aiDefaultsPreviewOptions,
  updateCachedAIAvailability,
} from "@/lib/organization/ai-config-queries";
import { queryView } from "@/lib/query-view.logic";
import { useQueryViewError } from "@/lib/use-query-view";
import { PROVIDER_SCOPE } from "@/routes/-app-frame-scope";

type AIAvailabilityContextValue = {
  ensureAIAvailable: () => Promise<boolean>;
  openAIKeyDialog: () => void;
  openIfAIUnavailable: () => void;
};

const AIAvailabilityContext = createContext<AIAvailabilityContextValue | null>(
  null,
);
const AIUnavailableContext = createContext<OrganizationAIAvailability | null>(
  null,
);

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
  const t = useTranslations();
  const queryClient = useQueryClient();
  const activeOrganizationId = useAuthenticatedUser().activeOrganizationId;
  const availabilityOptions = useMemo(
    () => aiAvailabilityOptions({ organizationId: activeOrganizationId }),
    [activeOrganizationId],
  );
  const dataQuery = useChromeQuery(availabilityOptions);
  const dataView = queryView(dataQuery);
  useQueryViewError(dataView, "AIAvailabilityRoot:query");
  const { isFetching } = dataQuery;
  const data = dataView.type === "items" ? dataView.items : undefined;

  const openAIKeyDialog = useCallback(() => {
    if (data?.providerConfiguration === "allowed") {
      setOpen(true);
    }
  }, [data]);

  const ensureAIAvailable = useCallback(async () => {
    const availability = await queryClient
      .query(availabilityOptions)
      .catch((error: unknown) => {
        getAnalytics().captureError(error, {
          fingerprintKey: "AIAvailabilityRoot:failure",
          scope: { type: "handler", handlerId: "AIAvailabilityRoot:failure" },
        });
        return null;
      });

    // Availability is advisory: the send endpoint owns provider selection and
    // remains the authority when this independent settings read fails.
    if (availability === null) {
      return (
        resolveAIProviderSettings({
          orgConfigured: false,
          providerConfiguration: "permission_required",
          readStatus: "unavailable",
        }).type === "defaultProvider"
      );
    }

    if (availability.available) {
      return true;
    }

    if (availability.providerConfiguration === "allowed") {
      setOpen(true);
      return false;
    }
    // This member cannot connect a provider, so the action they triggered
    // stops here; say why instead of doing nothing.
    stellaToast.add({
      title: t(aiUnavailableMessageKey(availability)),
      type: "info",
    });
    return false;
  }, [availabilityOptions, queryClient, t]);

  const openIfAIUnavailable = useCallback(() => {
    if (
      dataQuery.status === "success" &&
      data &&
      !data.available &&
      data.providerConfiguration === "allowed" &&
      !isFetching
    ) {
      setOpen(true);
    }
  }, [data, dataQuery.status, isFetching]);
  const aiUnavailable =
    dataQuery.status === "success" && data && !data.available && !isFetching
      ? data
      : null;

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

export const useAIKeyGate = () =>
  useRequiredRouteProvider({
    context: AIAvailabilityContext,
    scope: PROVIDER_SCOPE.ai,
    missingMessage: "useAIKeyGate must be used within AIAvailabilityProvider",
  });

const OpenAIKeyDialogOnMount = ({ open }: { open: () => void }) => {
  useMountEffect(() => {
    open();
  });
  return null;
};

export const AIUnavailableDialogTrigger = () => {
  const availability = use(AIUnavailableContext);
  const { openAIKeyDialog } = useAIKeyGate();
  if (availability === null) {
    return null;
  }
  if (availability.providerConfiguration !== "allowed") {
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
  const dataView = queryView(dataQuery);
  useQueryViewError(dataView, "RequireAIKey:query");
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
    return children;
  }

  if (data?.available) {
    return children;
  }

  return (
    <div className="flex h-full w-full flex-1 items-center justify-center p-6">
      {data?.providerConfiguration === "allowed" ? (
        <AIUnavailableDialogTrigger />
      ) : null}
      <div className="border-border bg-card text-card-foreground flex max-w-md flex-col gap-4 rounded-lg border p-6 shadow-sm">
        <div className="flex flex-col gap-1">
          <h2 className="text-foreground text-lg font-semibold">
            {t("ai.keyRequired.title")}
          </h2>
          <p className="text-muted-foreground text-sm">
            {data === undefined
              ? t("ai.keyRequired.description")
              : t(aiUnavailableMessageKey(data))}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {data?.providerConfiguration === "allowed" ? (
            <>
              <Button onClick={openAIKeyDialog}>
                {t("ai.keyRequired.cta")}
              </Button>
              <Button render={<Link to="/admin/ai" />} variant="ghost">
                {t("organization.aiConfig.title")}
              </Button>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
};

function aiUnavailableMessageKey(availability: OrganizationAIAvailability) {
  switch (availability.unavailableReason) {
    case "member_assignment_required":
      return "ai.keyRequired.seatRequired" as const;
    case "unreadable":
      return "ai.keyRequired.configUnreadable" as const;
    case "own_key_required":
    case "provider_not_configured":
      return "ai.keyRequired.description" as const;
    case null:
      return panic("Available AI rendered an unavailable message");
    default:
      availability.unavailableReason satisfies never;
      return panic("Unhandled AI unavailable reason");
  }
}

const ACCOUNT_ACCESS_UNAVAILABLE_CODE = "account_access_unavailable";
const FORBIDDEN_STATUS = 403;

// The server refused the config read for this principal: say which refusal.
// Any other failure is transient and keeps the shared retry feedback.
const configRefusalMessageKey = (error: unknown) => {
  if (!APIError.is(error) || error.status !== FORBIDDEN_STATUS) {
    return null;
  }
  return error.code === ACCOUNT_ACCESS_UNAVAILABLE_CODE
    ? ("ai.keyRequired.accountRestricted" as const)
    : ("ai.keyRequired.permissionRequired" as const);
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
  const availabilityQuery = useChromeQuery(
    aiAvailabilityOptions({ organizationId: activeOrganizationId }),
  );
  const availabilityView = queryView(availabilityQuery);
  useQueryViewError(availabilityView, "AIKeyRequiredDialog:availability-query");
  const mayConfigure =
    availabilityView.type === "items" &&
    availabilityView.items.providerConfiguration === "allowed";
  const configQuery = useChromeQuery({
    ...aiConfigOptions({ organizationId: activeOrganizationId }),
    enabled: open && mayConfigure,
  });
  const configView = queryView(configQuery);
  useQueryViewError(configView, "AIKeyRequiredDialog:query");
  const configRefusalKey =
    configView.type === "error"
      ? configRefusalMessageKey(configView.error)
      : null;
  const config = configView.type === "items" ? configView.items : undefined;
  const [providers, setProviders] = useState<ProviderCredentialDraft[]>(
    DEFAULT_PROVIDER_DRAFTS,
  );
  const [roleModels, setRoleModels] = useState<RoleModelOverrides>({});

  const [initialProviders, setInitialProviders] = useState(
    DEFAULT_PROVIDER_DRAFTS,
  );
  const [initialRoleModels, setInitialRoleModels] =
    useState<RoleModelOverrides>({});

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
          roleOverridesFromStoredModels({
            overrideModels: config.overrideModels,
            providers: providerValues,
          }),
        );
        setRoleModels(
          roleOverridesFromStoredModels({
            overrideModels: config.overrideModels,
            providers: providerValues,
          }),
        );
      } else {
        const nextProviders = DEFAULT_PROVIDER_DRAFTS;
        setProviders(nextProviders);
        setInitialProviders(nextProviders);
        setInitialRoleModels({});
        setRoleModels({});
      }
    }
  }

  const updateProviders = (nextProviders: ProviderCredentialDraft[]) => {
    const providerValues = getProviderValues(nextProviders);
    setProviders(nextProviders);
    setRoleModels((prev) =>
      retainRoleOverridesForProviders({
        providers: providerValues,
        overrides: prev,
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
      const serialized = serializeRoleOverrides({
        providers: providerValues,
        overrides: roleModels,
      });
      if (serialized.kind === "invalid") {
        // The Configure button is disabled when `canSave` is false, which
        // checks the same serialization invariant.
        // The inline message at the field below renders the translated text.
        panic("ai-config save fired with no valid override models");
      }

      const response = await api["organization-settings"]["ai-config"].post({
        providers: serializeProviderDrafts(providers),
        overrideModels: serialized.overrides,
      });

      return unwrapApiResponse(response);
    },
    onSuccess: async (data) => {
      const savedProviders = providerDraftsFromStoredProviders(data.providers);
      queryClient.setQueryData(
        aiDefaultsPreviewOptions({
          organizationId: activeOrganizationId,
          providers: getProviderValues(savedProviders),
        }).queryKey,
        {
          defaultModels: projectDefaultRoleModels(data.defaultModels),
          providerDefaultModels: projectProviderDefaultRoleModels(
            data.providerDefaultModels,
          ),
        },
      );
      setProviders(savedProviders);
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
      analytics.captureError(error, {
        fingerprintKey: "AIKeyRequiredDialog:failure",
        scope: { type: "handler", handlerId: "AIKeyRequiredDialog:failure" },
      });
      notifyUserError(error, tErrors("actionFailed"));
    },
  });

  const providerValues = getProviderValues(providers);
  const storedProviderValues = config?.configured
    ? config.providers.map(({ provider }) => provider)
    : [];
  const defaultsQuery = useChromeQuery({
    ...aiDefaultsPreviewOptions({
      organizationId: activeOrganizationId,
      providers: providerValues,
    }),
    enabled: open && mayConfigure && configQuery.status === "success",
    ...(config !== undefined &&
    JSON.stringify(providerValues) === JSON.stringify(storedProviderValues)
      ? {
          initialData: {
            defaultModels: projectDefaultRoleModels(config.defaultModels),
            providerDefaultModels: projectProviderDefaultRoleModels(
              config.providerDefaultModels,
            ),
          },
        }
      : {}),
  });
  const defaultsView = queryView(defaultsQuery);
  useQueryViewError(defaultsView, "AIKeyRequiredDialog:defaults-query");
  const defaultModels =
    defaultsView.type === "items" ? defaultsView.items.defaultModels : null;
  const providerDefaultModels =
    defaultsView.type === "items"
      ? defaultsView.items.providerDefaultModels
      : [];
  const canSave =
    configQuery.status === "success" &&
    defaultModels !== null &&
    hasUsableProviderDrafts(providers) &&
    serializeRoleOverrides({ providers: providerValues, overrides: roleModels })
      .kind === "valid";

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogPopup className="max-h-[calc(100dvh-2rem)] overflow-hidden sm:max-w-3xl">
        <DialogFormState
          dirty={
            JSON.stringify(providers) !== JSON.stringify(initialProviders) ||
            !haveSameRoleModelSelections({
              current: roleModels,
              baseline: initialRoleModels,
            })
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
          {configRefusalKey !== null ? (
            <p className="text-muted-foreground text-sm">
              {t(configRefusalKey)}
            </p>
          ) : (
            <div className="grid gap-3">
              <QueryViewFeedback view={configView} />
              <AIConfigProvidersEditor
                compact
                disabled={saveMutation.isPending}
                onProvidersChange={updateProviders}
                providers={providers}
              />

              {defaultModels === null ? (
                <QueryViewFeedback view={defaultsView} />
              ) : (
                <AIConfigRoleModelPicker
                  compact
                  disabled={saveMutation.isPending}
                  onModelChange={setRoleModel}
                  providers={providerValues}
                  providerDefaultModels={providerDefaultModels}
                  roleModels={roleModelsFromOverrideModels({
                    overrideModels: roleModels,
                    providers: providerValues,
                    defaultModels,
                  })}
                />
              )}

              {!canSave && (
                <p className="text-destructive-foreground text-xs">
                  {tOrganization("aiConfig.selectModelForEachRole")}
                </p>
              )}
            </div>
          )}
        </div>
        <DialogFooter className="px-4 py-3">
          <DialogClose render={<Button variant="ghost" />}>
            {tCommon("cancel")}
          </DialogClose>
          <Button
            disabled={!canSave}
            loading={saveMutation.isPending}
            onClick={() => saveMutation.mutate()}
            title={configRefusalKey === null ? undefined : t(configRefusalKey)}
          >
            {tOrganization("aiConfig.configure")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
};
