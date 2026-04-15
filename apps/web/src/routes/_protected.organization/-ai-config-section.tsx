import { useEffect, useState } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2Icon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stella/ui/components/button";
import { Checkbox } from "@stella/ui/components/checkbox";
import { Field, FieldLabel } from "@stella/ui/components/field";
import { Input } from "@stella/ui/components/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stella/ui/components/select";
import { toastManager } from "@stella/ui/components/toast";

import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import {
  aiConfigKeys,
  aiConfigOptions,
} from "@/routes/_protected.organization/-ai-config-queries";

const PROVIDER_KEYS = [
  "google",
  "openrouter",
  "openai",
  "anthropic",
  "openai_compatible",
] as const;

const REGION_KEYS = ["global", "eu", "ch"] as const;

const ROLE_KEYS = ["fast", "chat", "reasoning", "pdf"] as const;

type ProviderValue = (typeof PROVIDER_KEYS)[number];
type RegionValue = (typeof REGION_KEYS)[number];
type RoleValue = (typeof ROLE_KEYS)[number];

const PROVIDER_VALUES = new Set<string>(PROVIDER_KEYS);
const REGION_VALUES = new Set<string>(REGION_KEYS);
const ROLE_VALUES = new Set<string>(ROLE_KEYS);

/** Providers that support EU/CH regional routing. */
const REGIONAL_PROVIDERS = new Set<ProviderValue>(["google"]);

const isProvider = (v: string): v is ProviderValue => PROVIDER_VALUES.has(v);
const isRegion = (v: string): v is RegionValue => REGION_VALUES.has(v);
const isRole = (v: string): v is RoleValue => ROLE_VALUES.has(v);

export const AIConfigSection = () => {
  const t = useTranslations("organization");
  const tCommon = useTranslations("common");
  const tSuccess = useTranslations("success");
  const tErrors = useTranslations("errors");
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  const { data: config } = useQuery(aiConfigOptions);

  const initialProvider =
    config?.configured && isProvider(config.provider)
      ? config.provider
      : "google";
  const initialRegion =
    config?.configured && isRegion(config.region) ? config.region : "global";
  const initialRoles = config?.configured
    ? config.overrideRoles.filter(isRole)
    : [];

  const [provider, setProvider] = useState<ProviderValue>(initialProvider);
  const [apiKey, setApiKey] = useState("");
  const [baseURL, setBaseURL] = useState(
    config?.configured ? (config.baseURL ?? "") : "",
  );
  const [region, setRegion] = useState<RegionValue>(initialRegion);
  const [overrideRoles, setOverrideRoles] = useState(initialRoles);

  // Sync form state when the config query resolves after
  // initial render (useState initializers only run once).
  // Intentionally depends only on `configured` to avoid
  // overwriting user edits on query refetch.
  useEffect(() => {
    if (!config?.configured) {
      return;
    }
    if (isProvider(config.provider)) {
      setProvider(config.provider);
    }
    if (isRegion(config.region)) {
      setRegion(config.region);
    }
    setOverrideRoles(config.overrideRoles.filter(isRole));
    setBaseURL(config.baseURL ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config?.configured]);

  const toggleRole = (role: RoleValue) => {
    setOverrideRoles((prev) =>
      prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role],
    );
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      const response = await api["organization-settings"]["ai-config"].post({
        provider,
        ...(apiKey ? { apiKey } : {}),
        ...(baseURL ? { baseURL } : {}),
        overrideRoles,
        region,
      });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    onSuccess: async () => {
      setApiKey("");
      await queryClient.invalidateQueries({
        queryKey: aiConfigKeys.all,
      });
      toastManager.add({
        title: tSuccess("aiConfigUpdated"),
        type: "success",
      });
    },
    onError: (error) => {
      analytics.captureError(error);
      toastManager.add({
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
      setApiKey("");
      await queryClient.invalidateQueries({
        queryKey: aiConfigKeys.all,
      });
      toastManager.add({
        title: tSuccess("aiConfigDeleted"),
        type: "success",
      });
    },
    onError: (error) => {
      analytics.captureError(error);
      toastManager.add({
        title: tErrors("actionFailed"),
        type: "error",
      });
    },
  });

  return (
    <div className="bg-card flex flex-col gap-3 rounded-xl border p-4">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-sm font-medium">{t("aiConfig.title")}</h3>
          <p className="text-muted-foreground text-xs">
            {t("aiConfig.description")}
          </p>
        </div>
        {config?.configured && (
          <Button
            loading={deleteMutation.isPending}
            onClick={() => deleteMutation.mutate()}
            size="sm"
            variant="ghost"
          >
            <Trash2Icon className="size-4" />
          </Button>
        )}
      </div>

      {config?.configured && (
        <div className="bg-muted flex items-center gap-2 rounded border px-3 py-2">
          <span className="text-muted-foreground text-xs">
            {t("aiConfig.active")}:
          </span>
          <span className="text-xs font-medium">
            {t(`aiConfig.providers.${config.provider}`)}
          </span>
          <span className="text-muted-foreground font-mono text-xs">
            {config.apiKeyMasked}
          </span>
        </div>
      )}

      <div className="flex flex-col gap-3">
        <Field>
          <FieldLabel>{t("aiConfig.provider")}</FieldLabel>
          <Select
            onValueChange={(val) => {
              if (val && isProvider(val)) {
                setProvider(val);
                if (!REGIONAL_PROVIDERS.has(val)) {
                  setRegion("global");
                }
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
                  {t(`aiConfig.providers.${key}`)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </Field>

        <Field>
          <FieldLabel>{t("aiConfig.apiKey")}</FieldLabel>
          <Input
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={
              config?.configured
                ? t("aiConfig.apiKeyUpdatePlaceholder")
                : t("aiConfig.apiKeyPlaceholder")
            }
            type="password"
            value={apiKey}
          />
        </Field>

        {provider === "openai_compatible" && (
          <Field>
            <FieldLabel>{t("aiConfig.baseUrl")}</FieldLabel>
            <Input
              onChange={(e) => setBaseURL(e.target.value)}
              placeholder="https://api.example.com/v1"
              value={baseURL}
            />
          </Field>
        )}

        <Field>
          <FieldLabel>{t("aiConfig.dataRegion")}</FieldLabel>
          <Select
            disabled={!REGIONAL_PROVIDERS.has(provider)}
            onValueChange={(val) => {
              if (val && isRegion(val)) {
                setRegion(val);
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
                  {t(`aiConfig.regions.${key}`)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <p className="text-muted-foreground text-xs">
            {REGIONAL_PROVIDERS.has(provider)
              ? t("aiConfig.dataRegionDescription")
              : t("aiConfig.dataRegionUnsupported")}
          </p>
        </Field>

        <Field>
          <FieldLabel>{t("aiConfig.overrideRoles")}</FieldLabel>
          <p className="text-muted-foreground text-xs">
            {t("aiConfig.overrideRolesDescription")}
          </p>
          <div className="mt-1 flex flex-wrap gap-3">
            {ROLE_KEYS.map((key) => (
              <label className="flex items-center gap-1.5 text-sm" key={key}>
                <Checkbox
                  checked={overrideRoles.includes(key)}
                  onCheckedChange={() => toggleRole(key)}
                />
                {t(`aiConfig.roles.${key}`)}
              </label>
            ))}
          </div>
        </Field>

        <Button
          className="self-start"
          disabled={!config?.configured && !apiKey}
          loading={saveMutation.isPending}
          onClick={() => saveMutation.mutate()}
          size="sm"
        >
          {config?.configured
            ? tCommon("saveChanges")
            : t("aiConfig.configure")}
        </Button>
      </div>
    </div>
  );
};
