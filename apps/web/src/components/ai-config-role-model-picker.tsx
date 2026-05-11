import { useTranslations } from "use-intl";

import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
} from "@stll/ui/components/combobox";
import { Field, FieldDescription, FieldLabel } from "@stll/ui/components/field";
import { Input } from "@stll/ui/components/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/components/select";
import { cn } from "@stll/ui/lib/utils";

import {
  CUSTOM_MODEL_ID_PROVIDERS,
  getDefaultModelSelection,
  getRolePickerRows,
  isProviderValue,
  MODEL_OPTIONS_BY_PROVIDER,
} from "@/components/ai-config-role-models.logic";
import type {
  ModelSelection,
  ProviderValue,
  RoleModelSelections,
  RoleValue,
} from "@/components/ai-config-role-models.logic";

type AIConfigRoleModelPickerProps = {
  className?: string;
  compact?: boolean;
  disabled?: boolean;
  onModelChange: (role: RoleValue, selection: ModelSelection | null) => void;
  providers: readonly ProviderValue[];
  roleModels: RoleModelSelections;
};

export const AIConfigRoleModelPicker = ({
  className,
  compact = false,
  disabled = false,
  onModelChange,
  providers,
  roleModels,
}: AIConfigRoleModelPickerProps) => {
  const t = useTranslations("organization");
  const rows = getRolePickerRows({ providers, roleModels });
  const hasProviders = providers.length > 0;

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
          const selectedProvider = row.selection?.provider ?? providers.at(0);
          const usesCustomModelId =
            selectedProvider !== undefined &&
            CUSTOM_MODEL_ID_PROVIDERS.has(selectedProvider);
          const modelOptions = selectedProvider
            ? MODEL_OPTIONS_BY_PROVIDER[selectedProvider].map((modelId) => ({
                modelId,
                provider: selectedProvider,
              }))
            : [];
          const selectedModelOption =
            modelOptions.find(
              (option) =>
                option.provider === row.selection?.provider &&
                option.modelId === row.selection.modelId,
            ) ?? null;

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

              <Select
                disabled={disabled || !hasProviders}
                onValueChange={(value) => {
                  if (!isProvider(value, providers)) {
                    return;
                  }
                  onModelChange(
                    row.role,
                    CUSTOM_MODEL_ID_PROVIDERS.has(value)
                      ? { provider: value, modelId: "" }
                      : getDefaultModelSelection(value, row.role),
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
                  <SelectValue placeholder={t("aiConfig.addProviderFirst")} />
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  {providers.map((provider) => (
                    <SelectItem key={provider} value={provider}>
                      {t(`aiConfig.providers.${provider}`)}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>

              {usesCustomModelId ? (
                <Input
                  aria-invalid={!row.selection?.modelId.trim()}
                  aria-label={t("aiConfig.modelForRole", {
                    role: roleLabel,
                  })}
                  className="min-w-0"
                  disabled={disabled || !selectedProvider}
                  onChange={(event) => {
                    const modelId = event.target.value;
                    onModelChange(
                      row.role,
                      modelId.trim()
                        ? { provider: selectedProvider, modelId }
                        : { provider: selectedProvider, modelId: "" },
                    );
                  }}
                  placeholder={t("aiConfig.deploymentNamePlaceholder")}
                  value={row.selection?.modelId ?? ""}
                />
              ) : (
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
