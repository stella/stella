import { PlusIcon, Trash2Icon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { Field, FieldDescription, FieldLabel } from "@stll/ui/components/field";
import { Input } from "@stll/ui/components/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/components/select";

import {
  createProviderCredentialDraft,
  ENDPOINT_REQUIRED_PROVIDERS,
  getAvailableProviderKeys,
  getNextAvailableProvider,
  isProviderValue,
  isRegionValue,
  PROVIDER_KEYS,
  PROVIDER_LABELS,
  REGION_KEYS,
  REGIONAL_PROVIDERS,
} from "@/components/ai-config-role-models.logic";
import type {
  ProviderCredentialDraft,
  ProviderValue,
} from "@/components/ai-config-role-models.logic";

const API_KEY_PLACEHOLDER = {
  google: "AIza...",
  anthropic: "sk-ant-...",
  mistral: "...",
  openai: "sk-proj-...",
  azure_foundry: "0123456789abcdef...",
  openrouter: "sk-or-v1-...",
  huggingface: "hf_...",
} as const satisfies Record<ProviderValue, string>;

const ENDPOINT_PLACEHOLDER = {
  azure_foundry: "https://<resource>.openai.azure.com/openai/v1",
  huggingface: "https://<id>.endpoints.huggingface.cloud/v1",
} as const;

const getEndpointPlaceholder = (provider: ProviderValue): string => {
  if (provider === "azure_foundry" || provider === "huggingface") {
    return ENDPOINT_PLACEHOLDER[provider];
  }
  return "";
};

export type ProviderRowStatus =
  | "idle"
  | "checking"
  | "valid"
  | "invalid"
  | "saved";

type AIConfigProvidersEditorProps = {
  compact?: boolean;
  disabled?: boolean;
  onProvidersChange: (providers: ProviderCredentialDraft[]) => void;
  providers: ProviderCredentialDraft[];
  // Optional inline-save UX for the onboarding flow. When supplied,
  // the editor renders a Save button per row so the user explicitly
  // confirms each key before validation/network requests fire.
  onSaveRow?: (index: number) => void;
  rowStatuses?: ProviderRowStatus[];
};

export const AIConfigProvidersEditor = ({
  compact = false,
  disabled = false,
  onProvidersChange,
  providers,
  onSaveRow,
  rowStatuses,
}: AIConfigProvidersEditorProps) => {
  const t = useTranslations("organization");
  const tCommon = useTranslations("common");
  const canAddProvider = providers.length < PROVIDER_KEYS.length;

  const updateProvider = (
    index: number,
    nextProvider: ProviderCredentialDraft,
  ) => {
    onProvidersChange(
      providers.map((provider, providerIndex) =>
        providerIndex === index ? nextProvider : provider,
      ),
    );
  };

  const addProvider = () => {
    const provider = getNextAvailableProvider(providers);
    if (!provider) {
      return;
    }
    onProvidersChange([...providers, createProviderCredentialDraft(provider)]);
  };

  const removeProvider = (index: number) => {
    onProvidersChange(
      providers.filter((_, providerIndex) => providerIndex !== index),
    );
  };

  return (
    <Field>
      <div className="flex w-full items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <FieldLabel>{t("aiConfig.providersPanel")}</FieldLabel>
          {!compact && (
            <FieldDescription>
              {t("aiConfig.providersDescription")}
            </FieldDescription>
          )}
        </div>
        <Button
          disabled={disabled || !canAddProvider}
          className="ms-auto shrink-0"
          onClick={addProvider}
          size="sm"
          type="button"
          variant="ghost"
        >
          <PlusIcon className="size-4" />
          {t("aiConfig.addProvider")}
        </Button>
      </div>

      <div className="w-full overflow-hidden rounded-md border">
        {providers.map((providerDraft, index) => {
          const supportsRegionalRouting = REGIONAL_PROVIDERS.has(
            providerDraft.provider,
          );
          const needsEndpoint = ENDPOINT_REQUIRED_PROVIDERS.has(
            providerDraft.provider,
          );
          const providerOptions = getAvailableProviderKeys({
            currentProvider: providerDraft.provider,
            providers,
          });
          const savedKey = providerDraft.apiKeyMasked;
          const hasSavedKey = savedKey !== undefined;
          const showKeyInput = providerDraft.replacingKey || !hasSavedKey;

          if (compact) {
            const rowStatus: ProviderRowStatus = rowStatuses?.[index] ?? "idle";
            const hasUsableKey =
              (providerDraft.apiKey.trim().length > 0 ||
                (hasSavedKey && !providerDraft.replacingKey)) &&
              (!needsEndpoint || providerDraft.endpoint.trim().length > 0);
            const showSaveButton =
              onSaveRow !== undefined &&
              hasUsableKey &&
              rowStatus !== "saved" &&
              rowStatus !== "valid";
            return (
              <div
                className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-2 gap-y-1 border-t p-2 first:border-t-0 sm:grid-cols-[minmax(5rem,0.7fr)_minmax(0,1fr)_minmax(5rem,0.7fr)_auto] sm:items-center"
                key={`${providerDraft.provider}-${index}`}
              >
                <Select
                  disabled={disabled}
                  onValueChange={(value) => {
                    if (!isProviderValue(value)) {
                      return;
                    }

                    updateProvider(index, {
                      ...createProviderCredentialDraft(value),
                      apiKey: "",
                      apiKeyMasked: undefined,
                      replacingKey: true,
                    });
                  }}
                  value={providerDraft.provider}
                >
                  <SelectTrigger
                    aria-label={t("aiConfig.provider")}
                    className="min-w-0"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup alignItemWithTrigger={false}>
                    {providerOptions.map((provider) => (
                      <SelectItem key={provider} value={provider}>
                        {PROVIDER_LABELS[provider]}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>

                <div className="min-w-0">
                  {showKeyInput ? (
                    <Input
                      aria-label={
                        hasSavedKey
                          ? t("aiConfig.newApiKey")
                          : t("aiConfig.apiKey")
                      }
                      autoComplete="off"
                      disabled={disabled}
                      onChange={(event) =>
                        updateProvider(index, {
                          ...providerDraft,
                          apiKey: event.target.value,
                          replacingKey: true,
                        })
                      }
                      placeholder={
                        hasSavedKey
                          ? t("aiConfig.newApiKey")
                          : API_KEY_PLACEHOLDER[providerDraft.provider]
                      }
                      type="password"
                      value={providerDraft.apiKey}
                    />
                  ) : (
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="bg-muted text-muted-foreground min-w-0 flex-1 truncate rounded border px-2 py-1 font-mono text-xs">
                        {t("aiConfig.apiKeySaved", { key: savedKey })}
                      </span>
                      <Button
                        disabled={disabled}
                        onClick={() =>
                          updateProvider(index, {
                            ...providerDraft,
                            apiKey: "",
                            replacingKey: true,
                          })
                        }
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        {t("aiConfig.replaceKey")}
                      </Button>
                    </div>
                  )}
                </div>

                <div className="min-w-0">
                  {supportsRegionalRouting && (
                    <Select
                      disabled={disabled}
                      onValueChange={(value) => {
                        if (isRegionValue(value)) {
                          updateProvider(index, {
                            ...providerDraft,
                            region: value,
                          });
                        }
                      }}
                      value={providerDraft.region}
                    >
                      <SelectTrigger
                        aria-label={t("aiConfig.dataRegion")}
                        className="min-w-0"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectPopup alignItemWithTrigger={false}>
                        {REGION_KEYS.map((region) => (
                          <SelectItem key={region} value={region}>
                            {t(`aiConfig.regions.${region}`)}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  )}
                </div>

                {needsEndpoint && (
                  <Input
                    aria-label={t("aiConfig.endpoint")}
                    className="col-span-2 min-w-0 sm:col-span-2 sm:col-start-2"
                    disabled={disabled}
                    onChange={(event) =>
                      updateProvider(index, {
                        ...providerDraft,
                        endpoint: event.target.value,
                      })
                    }
                    placeholder={getEndpointPlaceholder(providerDraft.provider)}
                    value={providerDraft.endpoint}
                  />
                )}

                {showSaveButton ? (
                  <Button
                    disabled={disabled || rowStatus === "checking"}
                    loading={rowStatus === "checking"}
                    onClick={() => onSaveRow(index)}
                    size="sm"
                    type="button"
                    variant={rowStatus === "invalid" ? "outline" : "default"}
                  >
                    {rowStatus === "invalid"
                      ? tCommon("retry")
                      : tCommon("save")}
                  </Button>
                ) : (
                  <Button
                    aria-label={t("aiConfig.removeProvider")}
                    disabled={disabled || providers.length === 1}
                    onClick={() => removeProvider(index)}
                    size="icon"
                    type="button"
                    variant="ghost"
                  >
                    <Trash2Icon className="size-4" />
                  </Button>
                )}
              </div>
            );
          }

          return (
            <div
              className="grid gap-3 border-t p-3 first:border-t-0"
              key={`${providerDraft.provider}-${index}`}
            >
              <div className="grid gap-2 sm:grid-cols-[minmax(8rem,0.85fr)_minmax(0,1fr)] sm:items-start">
                <Field className="min-w-0">
                  <FieldLabel>{t("aiConfig.provider")}</FieldLabel>
                  <Select
                    disabled={disabled}
                    onValueChange={(value) => {
                      if (!isProviderValue(value)) {
                        return;
                      }

                      updateProvider(index, {
                        ...createProviderCredentialDraft(value),
                        apiKey: "",
                        apiKeyMasked: undefined,
                        replacingKey: true,
                      });
                    }}
                    value={providerDraft.provider}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup alignItemWithTrigger={false}>
                      {providerOptions.map((provider) => (
                        <SelectItem key={provider} value={provider}>
                          {PROVIDER_LABELS[provider]}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </Field>

                <div className="flex min-w-0 flex-wrap items-center justify-end gap-2 sm:pt-6">
                  {hasSavedKey && !providerDraft.replacingKey && (
                    <>
                      <span className="bg-muted text-muted-foreground min-w-0 truncate rounded border px-2 py-1 font-mono text-xs">
                        {t("aiConfig.apiKeySaved", {
                          key: savedKey,
                        })}
                      </span>
                      <Button
                        disabled={disabled}
                        onClick={() =>
                          updateProvider(index, {
                            ...providerDraft,
                            apiKey: "",
                            replacingKey: true,
                          })
                        }
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        {t("aiConfig.replaceKey")}
                      </Button>
                    </>
                  )}

                  {hasSavedKey && providerDraft.replacingKey && (
                    <Button
                      disabled={disabled}
                      onClick={() =>
                        updateProvider(index, {
                          ...providerDraft,
                          apiKey: "",
                          replacingKey: false,
                        })
                      }
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      {t("aiConfig.keepSavedKey")}
                    </Button>
                  )}

                  <Button
                    disabled={disabled || providers.length === 1}
                    onClick={() => removeProvider(index)}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    <Trash2Icon className="size-4" />
                    {t("aiConfig.removeProvider")}
                  </Button>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                {needsEndpoint && (
                  <Field>
                    <FieldLabel>{t("aiConfig.endpoint")}</FieldLabel>
                    <Input
                      autoComplete="off"
                      disabled={disabled}
                      onChange={(event) =>
                        updateProvider(index, {
                          ...providerDraft,
                          endpoint: event.target.value,
                        })
                      }
                      placeholder={getEndpointPlaceholder(
                        providerDraft.provider,
                      )}
                      type="url"
                      value={providerDraft.endpoint}
                    />
                    {
                      <p className="text-muted-foreground text-xs">
                        {t("aiConfig.endpointDescription")}
                      </p>
                    }
                  </Field>
                )}

                {showKeyInput && (
                  <Field>
                    <FieldLabel>
                      {hasSavedKey
                        ? t("aiConfig.newApiKey")
                        : t("aiConfig.apiKey")}
                    </FieldLabel>
                    <Input
                      autoComplete="off"
                      disabled={disabled}
                      onChange={(event) =>
                        updateProvider(index, {
                          ...providerDraft,
                          apiKey: event.target.value,
                          replacingKey: true,
                        })
                      }
                      placeholder={API_KEY_PLACEHOLDER[providerDraft.provider]}
                      type="password"
                      value={providerDraft.apiKey}
                    />
                    {hasSavedKey && (
                      <p className="text-muted-foreground text-xs">
                        {t("aiConfig.newApiKeyDescription")}
                      </p>
                    )}
                  </Field>
                )}

                {supportsRegionalRouting && (
                  <Field>
                    <FieldLabel>{t("aiConfig.dataRegion")}</FieldLabel>
                    <Select
                      disabled={disabled}
                      onValueChange={(value) => {
                        if (isRegionValue(value)) {
                          updateProvider(index, {
                            ...providerDraft,
                            region: value,
                          });
                        }
                      }}
                      value={providerDraft.region}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectPopup alignItemWithTrigger={false}>
                        {REGION_KEYS.map((region) => (
                          <SelectItem key={region} value={region}>
                            {t(`aiConfig.regions.${region}`)}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                    {
                      <p className="text-muted-foreground text-xs">
                        {t("aiConfig.dataRegionDescription")}
                      </p>
                    }
                  </Field>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Field>
  );
};
