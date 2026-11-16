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
import { Field, FieldLabel } from "@stll/ui/field";
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
  DECISION_PROVIDER_KEYS,
  decisionModelDraft,
} from "@/components/ai-config-role-models.logic";
import type {
  DecisionModelState,
  DecisionProviderValue,
  StoredDecisionModel,
} from "@/components/ai-config-role-models.logic";
import { matchesComboboxItem } from "@/components/combobox-filter.logic";
import { SecretInput } from "@/components/secret-input";

const DEFAULT_SELECTION = "default";

type AIConfigDecisionModelProps = {
  disabled: boolean;
  hasOpenAIKey: boolean;
  instanceProvisioned: boolean;
  onStateChange: (state: DecisionModelState) => void;
  state: DecisionModelState;
  stored: StoredDecisionModel | null;
};

export const AIConfigDecisionModel = ({
  disabled,
  hasOpenAIKey,
  instanceProvisioned,
  onStateChange,
  state,
  stored,
}: AIConfigDecisionModelProps) => {
  const t = useTranslations("organization");
  const common = useTranslations("common");
  const tAuth = useTranslations("auth");
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

  const editDecision = (changes: {
    apiKey?: string;
    modelId?: string;
    region?: "eu" | "global";
    keyMode?: "reuse" | "override";
  }) => {
    if (!draft) {
      return;
    }
    const apiKey = changes.apiKey ?? draft.apiKey;
    const modelId = changes.modelId ?? draft.modelId;
    onStateChange(
      draft.provider === "openai"
        ? {
            kind: "set",
            provider: "openai",
            apiKey,
            modelId,
            region: changes.region ?? draft.region,
            keyMode: changes.keyMode ?? draft.keyMode,
          }
        : { kind: "set", provider: "typesafe", apiKey, modelId },
    );
  };

  return (
    <AIConfigModelRow label={role}>
      <Select
        disabled={disabled}
        value={draft?.provider ?? DEFAULT_SELECTION}
        onValueChange={(value) => {
          if (value === DEFAULT_SELECTION) {
            onStateChange({ kind: "cleared" });
          } else if (isDecisionProvider(value)) {
            onStateChange(createDecisionModelState(value, hasOpenAIKey));
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
              {provider === "openai" && (
                <span className="text-muted-foreground ms-2 text-xs">
                  {tAuth("betaNoticeTitle")}
                </span>
              )}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      <Combobox
        disabled={disabled || draft === null}
        filter={matchesComboboxItem}
        items={modelOptions}
        value={draft?.modelId ?? null}
        inputValue={draft?.modelId ?? ""}
        onInputValueChange={(modelId) => {
          if (draft && modelId !== draft.modelId) {
            editDecision({ modelId });
          }
        }}
        onValueChange={(modelId) => {
          if (draft && modelId !== null) {
            editDecision({ modelId });
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
      {draft &&
        (draft.provider !== "openai" || draft.keyMode === "override") && (
          <Field className="min-w-0 sm:col-span-2 sm:col-start-2">
            <SecretInput
              aria-label={t("aiConfig.apiKey")}
              autoComplete="off"
              disabled={disabled}
              onChange={(event) => editDecision({ apiKey: event.target.value })}
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
      {draft?.provider === "openai" && (
        <div className="grid min-w-0 gap-3 sm:col-span-2 sm:col-start-2 sm:grid-cols-2">
          <Field>
            <FieldLabel>{t("aiConfig.apiKey")}</FieldLabel>
            <Select
              disabled={disabled}
              value={draft.keyMode}
              onValueChange={(value) => {
                if (value === "reuse" || value === "override") {
                  editDecision({ keyMode: value, apiKey: "" });
                }
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                <SelectItem disabled={!hasOpenAIKey} value="reuse">
                  {t("aiConfig.decision.reuseOpenAIKey")}
                </SelectItem>
                <SelectItem value="override">
                  {t("aiConfig.decision.separateKey")}
                </SelectItem>
              </SelectPopup>
            </Select>
          </Field>
          <Field>
            <FieldLabel>{t("aiConfig.decision.dataRegion")}</FieldLabel>
            <Select
              disabled={disabled}
              value={draft.region}
              onValueChange={(value) => {
                if (value === "eu" || value === "global") {
                  editDecision({ region: value });
                }
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                <SelectItem value="eu">
                  {t("aiConfig.decision.regionEu")}
                </SelectItem>
                <SelectItem value="global">
                  {t("aiConfig.decision.regionGlobal")}
                </SelectItem>
              </SelectPopup>
            </Select>
          </Field>
        </div>
      )}
    </AIConfigModelRow>
  );
};

const isDecisionProvider = (
  value: string | null,
): value is DecisionProviderValue =>
  value !== null &&
  DECISION_PROVIDER_KEYS.some((provider) => provider === value);
