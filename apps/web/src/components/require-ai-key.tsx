import type { PropsWithChildren } from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import { Button } from "@stll/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/components/dialog";
import { Field, FieldLabel } from "@stll/ui/components/field";
import { Input } from "@stll/ui/components/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/components/select";
import { toastManager } from "@stll/ui/components/toast";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import {
  aiAvailabilityOptions,
  aiConfigKeys,
} from "@/routes/_protected.organization/-ai-config-queries";

const PROVIDER_KEYS = [
  "google",
  "openrouter",
  "openai",
  "anthropic",
  "openai_compatible",
] as const;

const REGION_KEYS = ["global", "eu", "ch"] as const;

type ProviderValue = (typeof PROVIDER_KEYS)[number];
type RegionValue = (typeof REGION_KEYS)[number];

const REGIONAL_PROVIDERS = new Set<ProviderValue>(["google"]);

const API_KEY_PLACEHOLDER = {
  google: "AIza...",
  openrouter: "sk-or-v1-...",
  openai: "sk-proj-...",
  anthropic: "sk-ant-...",
  openai_compatible: "sk-...",
} as const satisfies Record<ProviderValue, string>;

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
  const { data } = useQuery(aiAvailabilityOptions);

  const openAIKeyDialog = useCallback(() => {
    setOpen(true);
  }, []);

  const ensureAIAvailable = useCallback(async () => {
    const availability = await queryClient
      .ensureQueryData(aiAvailabilityOptions)
      .catch(() => undefined);

    if (availability?.available) {
      return true;
    }

    setOpen(true);
    return false;
  }, [queryClient]);

  const openIfAIUnavailable = useCallback(() => {
    if (data && !data.available) {
      setOpen(true);
    }
  }, [data]);

  const value = useMemo(
    () => ({
      ensureAIAvailable,
      openAIKeyDialog,
      openIfAIUnavailable,
    }),
    [ensureAIAvailable, openAIKeyDialog, openIfAIUnavailable],
  );

  return (
    <AIAvailabilityContext.Provider value={value}>
      {children}
      <AIKeyRequiredDialog onOpenChange={setOpen} open={open} />
    </AIAvailabilityContext.Provider>
  );
}

export const useAIKeyGate = () => {
  const context = useContext(AIAvailabilityContext);

  if (!context) {
    throw new Error("useAIKeyGate must be used within AIAvailabilityProvider");
  }

  return context;
};

/**
 * Whether AI features are available right now: either the org has
 * BYOK or the instance has provisioned keys.
 */
export function useAIAvailable(): boolean {
  const { data, isError } = useQuery(aiAvailabilityOptions);
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
  const { data, isPending, isError } = useQuery(aiAvailabilityOptions);
  const { openAIKeyDialog, openIfAIUnavailable } = useAIKeyGate();

  useEffect(() => {
    openIfAIUnavailable();
  }, [openIfAIUnavailable]);

  if (isPending) {
    return null;
  }

  if (!isError && data?.available) {
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
  const [provider, setProvider] = useState<ProviderValue>("google");
  const [apiKey, setApiKey] = useState("");
  const [baseURL, setBaseURL] = useState("");
  const [region, setRegion] = useState<RegionValue>("global");

  useEffect(() => {
    if (!REGIONAL_PROVIDERS.has(provider)) {
      setRegion("global");
    }
  }, [provider]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const response = await api["organization-settings"]["ai-config"].post({
        provider,
        apiKey,
        ...(provider === "openai_compatible" ? { baseURL } : {}),
        overrideRoles: [],
        region,
      });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    onSuccess: async () => {
      setApiKey("");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: aiConfigKeys.all }),
        queryClient.invalidateQueries({ queryKey: aiConfigKeys.availability }),
      ]);
      toastManager.add({
        title: tSuccess("aiConfigUpdated"),
        type: "success",
      });
      onOpenChange(false);
    },
    onError: (error) => {
      analytics.captureError(error);
      toastManager.add({
        title: error instanceof Error ? error.message : tErrors("actionFailed"),
        type: "error",
      });
    },
  });

  const needsBaseURL = provider === "openai_compatible";
  const canSave: boolean =
    apiKey.trim().length > 0 && (!needsBaseURL || baseURL.trim().length > 0);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("ai.keyRequired.title")}</DialogTitle>
          <DialogDescription>
            {t("ai.keyRequired.description")}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="grid gap-4">
          <Field>
            <FieldLabel>{tOrganization("aiConfig.provider")}</FieldLabel>
            <Select
              onValueChange={(value) => {
                if (isProviderValue(value)) {
                  setProvider(value);
                }
              }}
              value={provider}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                {PROVIDER_KEYS.map((key) => (
                  <SelectItem key={key} value={key}>
                    {tOrganization(`aiConfig.providers.${key}`)}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </Field>

          <Field>
            <FieldLabel>{tOrganization("aiConfig.apiKey")}</FieldLabel>
            <Input
              autoComplete="off"
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={API_KEY_PLACEHOLDER[provider]}
              type="password"
              value={apiKey}
            />
          </Field>

          {needsBaseURL && (
            <Field>
              <FieldLabel>{tOrganization("aiConfig.baseUrl")}</FieldLabel>
              <Input
                onChange={(event) => setBaseURL(event.target.value)}
                placeholder="https://api.example.com/v1"
                value={baseURL}
              />
            </Field>
          )}

          <Field>
            <FieldLabel>{tOrganization("aiConfig.dataRegion")}</FieldLabel>
            <Select
              disabled={!REGIONAL_PROVIDERS.has(provider)}
              onValueChange={(value) => {
                if (isRegionValue(value)) {
                  setRegion(value);
                }
              }}
              value={region}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                {REGION_KEYS.map((key) => (
                  <SelectItem key={key} value={key}>
                    {tOrganization(`aiConfig.regions.${key}`)}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            {!REGIONAL_PROVIDERS.has(provider) && (
              <p className="text-muted-foreground text-xs">
                {tOrganization("aiConfig.dataRegionUnsupported")}
              </p>
            )}
          </Field>
        </DialogPanel>
        <DialogFooter>
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

const isProviderValue = (value: string | null): value is ProviderValue =>
  value !== null && PROVIDER_KEYS.some((key) => key === value);

const isRegionValue = (value: string | null): value is RegionValue =>
  value !== null && REGION_KEYS.some((key) => key === value);
