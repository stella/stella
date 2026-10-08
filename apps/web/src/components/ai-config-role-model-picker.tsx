import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
} from "@stll/ui/combobox";
import { Field, FieldDescription, FieldLabel } from "@stll/ui/field";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";
import { cn } from "@stll/ui/utils";

import {
  getDefaultModelSelection,
  getModelOptionsForRole,
  getRolePickerRows,
  isProviderRoleSupported,
  isProviderValue,
  PROVIDER_LABELS,
  DEFAULT_MODELS_BY_PROVIDER,
} from "@/components/ai-config-role-models.logic";
import type {
  ModelSelection,
  ProviderValue,
  RoleModelSelections,
  RoleValue,
  RoleModelOverrides,
} from "@/components/ai-config-role-models.logic";

type AIConfigRoleModelPickerProps = {
  className?: string;
  compact?: boolean;
  disabled?: boolean;
  onModelChange: (role: RoleValue, selection: ModelSelection | null) => void;
  providers: readonly ProviderValue[];
  roleModels: RoleModelSelections;
  customization?: {
    overrides: RoleModelOverrides;
    onReset: (role: RoleValue) => void;
  };
};

export const AIConfigRoleModelPicker = ({
  className,
  compact = false,
  disabled = false,
  onModelChange,
  providers,
  roleModels,
  customization,
}: AIConfigRoleModelPickerProps) => {
  const t = useTranslations("organization");
  const translate = useTranslations();
  const rows = getRolePickerRows({ providers, roleModels });

  return (
    <Field className={className}>
      <div className="flex flex-col gap-1">
        <FieldLabel>{t("aiConfig.modelsPanel")}</FieldLabel>
        {!compact && (
          <FieldDescription>{t("aiConfig.modelsDescription")}</FieldDescription>
        )}
      </div>

      <div className="w-full overflow-hidden rounded-md border">
        {rows.map((row) => {
          const roleLabel = t(`aiConfig.roles.${row.role}`);
          const selection = row.selection;
          const providerOptions = providers.filter((provider) =>
            isProviderRoleSupported(provider, row.role),
          );
          const unavailableProviders = providers.filter(
            (provider) =>
              DEFAULT_MODELS_BY_PROVIDER[provider][row.role].kind ===
              "unsupported",
          );
          const selectedProvider = selection?.provider ?? providerOptions.at(0);
          const defaultEntry = selectedProvider
            ? DEFAULT_MODELS_BY_PROVIDER[selectedProvider][row.role]
            : undefined;
          const modelOptions = selectedProvider
            ? getModelOptionsForRole({
                provider: selectedProvider,
                role: row.role,
              }).map((modelId) => ({
                modelId,
                provider: selectedProvider,
              }))
            : [];
          const selectedModelOption = selection
            ? (modelOptions.find(
                (option) =>
                  option.provider === selection.provider &&
                  option.modelId === selection.modelId,
              ) ?? null)
            : null;

          return (
            <div
              className={cn(
                "grid border-t first:border-t-0 sm:items-center",
                compact
                  ? "gap-2 p-2 sm:grid-cols-[7.5rem_8.5rem_minmax(0,1fr)]"
                  : "gap-3 p-3 sm:grid-cols-[minmax(10rem,0.65fr)_minmax(11rem,0.75fr)_minmax(14rem,1.35fr)]",
              )}
              key={row.role}
            >
              <span className="min-w-0 truncate text-sm font-medium">
                {roleLabel}
              </span>

              {providerOptions.length > 0 && (
                <>
                  <Select
                    disabled={disabled || providerOptions.length === 0}
                    onValueChange={(value) => {
                      if (!isProvider(value, providerOptions)) {
                        return;
                      }
                      onModelChange(
                        row.role,
                        getDefaultModelSelection(value, row.role),
                      );
                    }}
                    value={selectedProvider}
                  >
                    <SelectTrigger
                      aria-label={t("aiConfig.providerForRole", {
                        role: roleLabel,
                      })}
                      className="min-w-0"
                    >
                      <SelectValue
                        placeholder={t("aiConfig.addProviderFirst")}
                      />
                    </SelectTrigger>
                    <SelectPopup alignItemWithTrigger={false}>
                      {providerOptions.map((provider) => (
                        <SelectItem key={provider} value={provider}>
                          {PROVIDER_LABELS[provider]}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>

                  <Combobox<ModelSelection>
                    autoHighlight
                    disabled={disabled || !selectedProvider}
                    items={modelOptions}
                    itemToStringLabel={(option) => option.modelId}
                    onInputValueChange={(value) => {
                      if (!value.trim()) {
                        onModelChange(row.role, null);
                      }
                    }}
                    onValueChange={(option) => {
                      if (!option) {
                        return;
                      }

                      onModelChange(row.role, option);
                    }}
                    value={selectedModelOption}
                  >
                    <ComboboxInput
                      aria-invalid={!row.selection}
                      aria-label={t("aiConfig.modelForRole", {
                        role: roleLabel,
                      })}
                      className="min-w-0"
                      placeholder={t("aiConfig.modelIdPlaceholder")}
                      showClear={Boolean(row.selection)}
                    />
                    <ComboboxPopup>
                      <ComboboxList>
                        {(option: ModelSelection) => (
                          <ComboboxItem
                            key={`${option.provider}:${option.modelId}`}
                            value={option}
                          >
                            <span className="block min-w-0 truncate">
                              {option.modelId}
                            </span>
                          </ComboboxItem>
                        )}
                      </ComboboxList>
                      <ComboboxEmpty>
                        {t("aiConfig.noModelResults")}
                      </ComboboxEmpty>
                    </ComboboxPopup>
                  </Combobox>
                </>
              )}
              {unavailableProviders.map((provider) => (
                <p
                  key={provider}
                  className="text-muted-foreground text-xs wrap-anywhere sm:col-span-3"
                >
                  {t("aiConfig.roleUnavailable", {
                    provider: PROVIDER_LABELS[provider],
                  })}
                </p>
              ))}
              {customization && defaultEntry?.kind === "default" && (
                <div className="flex min-w-0 items-start justify-between gap-2 sm:col-span-3">
                  <div className="min-w-0 text-xs">
                    <p>
                      {Object.hasOwn(customization.overrides, row.role)
                        ? translate("common.custom")
                        : t("aiConfig.usingDefaults")}
                    </p>
                    <p className="text-muted-foreground wrap-anywhere">
                      {translate(defaultEntry.rationaleKey)}
                    </p>
                  </div>
                  {Object.hasOwn(customization.overrides, row.role) && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={disabled}
                      onClick={() => customization.onReset(row.role)}
                    >
                      {translate("common.resetToDefault")}
                    </Button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Field>
  );
};

const isProvider = (
  value: string | null,
  providers: readonly ProviderValue[],
): value is ProviderValue =>
  value !== null && isProviderValue(value) && providers.includes(value);
