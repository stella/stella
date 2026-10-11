import { useTranslations } from "use-intl";

import { DECISION_MODEL_CATALOG } from "@stll/ai-catalog";
import { Button } from "@stll/ui/button";
import {
  Combobox,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
} from "@stll/ui/combobox";
import { Field } from "@stll/ui/field";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";

import { AIConfigModelRow } from "@/components/ai-config-model-row";
import {
  createDecisionModelState,
  decisionModelDraft,
  DECISION_PROVIDER_KEYS,
} from "@/components/ai-config-role-models.logic";
import type {
  DecisionModelState,
  DecisionProviderValue,
  StoredDecisionModel,
} from "@/components/ai-config-role-models.logic";
import { SecretInput } from "@/components/secret-input";

const DEFAULT_SELECTION = "default";

type AIConfigDecisionModelProps = {
  disabled: boolean;
  instanceProvisioned: boolean;
  onStateChange: (state: DecisionModelState) => void;
  state: DecisionModelState;
  stored: StoredDecisionModel | null;
};

export const AIConfigDecisionModel = ({
  disabled,
  instanceProvisioned,
  onStateChange,
  state,
  stored,
}: AIConfigDecisionModelProps) => {
  const t = useTranslations("organization");
  const common = useTranslations("common");
  const draft = decisionModelDraft({ state, stored });
  const role = t("aiConfig.decision.label");
  const modelOptions = draft
    ? Array.from(
        new Set(
          [
            DECISION_MODEL_CATALOG[draft.provider].defaultModelId,
            draft.modelId,
          ].filter(Boolean),
        ),
      )
    : [];

  return (
    <AIConfigModelRow label={role}>
      <Select
        disabled={disabled}
        value={draft?.provider ?? DEFAULT_SELECTION}
        onValueChange={(value) => {
          if (value === DEFAULT_SELECTION) {
            onStateChange({ kind: "cleared" });
          } else if (isDecisionProvider(value)) {
            onStateChange(createDecisionModelState(value));
          }
        }}
      >
        <SelectTrigger
          aria-label={t("aiConfig.providerForRole", { role })}
          className="min-w-0"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectPopup alignItemWithTrigger={false}>
          <SelectItem value={DEFAULT_SELECTION}>
            {t("aiConfig.usingDefaults")}
          </SelectItem>
          {DECISION_PROVIDER_KEYS.map((provider) => (
            <SelectItem key={provider} value={provider}>
              {DECISION_MODEL_CATALOG[provider].label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      <Combobox
        disabled={disabled || draft === null}
        items={modelOptions}
        value={draft?.modelId ?? null}
        inputValue={draft?.modelId ?? ""}
        onInputValueChange={(modelId) => {
          if (draft && modelId !== draft.modelId) {
            onStateChange({
              kind: "set",
              provider: draft.provider,
              apiKey: draft.apiKey,
              modelId,
            });
          }
        }}
        onValueChange={(modelId) => {
          if (draft && modelId !== null) {
            onStateChange({
              kind: "set",
              provider: draft.provider,
              apiKey: draft.apiKey,
              modelId,
            });
          }
        }}
      >
        <ComboboxInput
          aria-label={t("aiConfig.modelForRole", { role })}
          aria-invalid={draft !== null && !draft.modelId.trim()}
          className="min-w-0"
          placeholder={t("aiConfig.usingDefaults")}
        />
        <ComboboxPopup>
          <ComboboxList>
            {(modelId: string) => (
              <ComboboxItem key={modelId} value={modelId}>
                {modelId}
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxPopup>
      </Combobox>
      <div className="flex min-w-0 items-start justify-between gap-2 sm:col-span-3">
        <div className="min-w-0 text-xs">
          <p>{draft ? common("custom") : t("aiConfig.usingDefaults")}</p>
          <p className="text-muted-foreground wrap-anywhere">
            {t("aiConfig.decision.description")}
          </p>
          {draft === null && (
            <p className="text-muted-foreground wrap-anywhere">
              {t(
                instanceProvisioned
                  ? "aiConfig.decision.instanceProvided"
                  : "aiConfig.decision.generativeFallback",
              )}
            </p>
          )}
        </div>
        {draft && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={() => onStateChange({ kind: "cleared" })}
          >
            {common("resetToDefault")}
          </Button>
        )}
      </div>
      {draft && (
        <Field className="min-w-0 sm:col-span-2 sm:col-start-2">
          <SecretInput
            aria-label={t("aiConfig.apiKey")}
            autoComplete="off"
            disabled={disabled}
            onChange={(event) =>
              onStateChange({
                kind: "set",
                provider: draft.provider,
                apiKey: event.target.value,
                modelId: draft.modelId,
              })
            }
            placeholder={
              draft.apiKeyMasked === undefined
                ? t("aiConfig.apiKeyPlaceholder")
                : t("aiConfig.apiKeyConfiguredPlaceholder", {
                    key: draft.apiKeyMasked,
                  })
            }
            value={draft.apiKey}
          />
        </Field>
      )}
    </AIConfigModelRow>
  );
};

const isDecisionProvider = (
  value: string | null,
): value is DecisionProviderValue =>
  value !== null &&
  DECISION_PROVIDER_KEYS.some((provider) => provider === value);
