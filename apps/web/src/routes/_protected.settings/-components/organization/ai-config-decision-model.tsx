import { PlusIcon, Trash2Icon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Field, FieldDescription, FieldLabel } from "@stll/ui/field";
import { Input } from "@stll/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";

import {
  createDecisionModelState,
  decisionModelDraft,
  DECISION_PROVIDER_KEYS,
  DECISION_PROVIDER_LABELS,
  DEFAULT_DECISION_MODEL_ID,
} from "@/components/ai-config-role-models.logic";
import type {
  DecisionModelState,
  DecisionProviderValue,
  StoredDecisionModel,
} from "@/components/ai-config-role-models.logic";
import { SecretInput } from "@/components/secret-input";

type AIConfigDecisionModelProps = {
  disabled?: boolean;
  /** The instance carries a decision model orgs without one fall back to. */
  instanceProvisioned: boolean;
  onStateChange: (state: DecisionModelState) => void;
  state: DecisionModelState;
  stored: StoredDecisionModel | null;
};

export const AIConfigDecisionModel = ({
  disabled = false,
  instanceProvisioned,
  onStateChange,
  state,
  stored,
}: AIConfigDecisionModelProps) => {
  const t = useTranslations("organization");
  const tCommon = useTranslations("common");
  const draft = decisionModelDraft({ state, stored });

  // Each edit rebuilds the whole `set` branch, so a field a previous branch
  // carried can never leak through into the next state.
  const setDecision = (next: {
    provider: DecisionProviderValue;
    apiKey: string;
    modelId: string;
  }) => onStateChange({ kind: "set", ...next });

  return (
    <Field>
      <div className="flex w-full items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <FieldLabel>{t("aiConfig.decision.label")}</FieldLabel>
          <FieldDescription>
            {t("aiConfig.decision.description")}
          </FieldDescription>
        </div>
        {draft === null && (
          <Button
            className="ms-auto shrink-0"
            disabled={disabled}
            onClick={() => onStateChange(createDecisionModelState())}
            size="sm"
            type="button"
            variant="ghost"
          >
            <PlusIcon className="size-4" />
            {t("aiConfig.decision.add")}
          </Button>
        )}
      </div>

      {draft === null ? (
        instanceProvisioned && (
          <p className="text-muted-foreground text-xs">
            {t("aiConfig.decision.instanceProvided")}
          </p>
        )
      ) : (
        <div className="grid w-full gap-3 rounded-md border p-3 sm:grid-cols-[minmax(8rem,0.7fr)_minmax(0,1.2fr)_minmax(0,1fr)] sm:items-start">
          <Field className="min-w-0">
            <FieldLabel>{t("aiConfig.provider")}</FieldLabel>
            <Select
              disabled={disabled}
              onValueChange={(value) => {
                if (!isDecisionProvider(value)) {
                  return;
                }
                // The stored key was issued for the previous provider, so the
                // switch starts the new one without a key to reuse.
                setDecision({
                  provider: value,
                  apiKey: "",
                  modelId: draft.modelId,
                });
              }}
              value={draft.provider}
            >
              <SelectTrigger className="min-w-0">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                {DECISION_PROVIDER_KEYS.map((provider) => (
                  <SelectItem key={provider} value={provider}>
                    {DECISION_PROVIDER_LABELS[provider]}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </Field>

          <Field className="min-w-0">
            <FieldLabel>
              {draft.apiKeyMasked === undefined
                ? t("aiConfig.apiKey")
                : t("aiConfig.newApiKey")}
            </FieldLabel>
            <SecretInput
              autoComplete="off"
              disabled={disabled}
              onChange={(event) =>
                setDecision({
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

          <div className="flex min-w-0 items-end gap-2">
            <Field className="min-w-0 flex-1">
              <FieldLabel>{t("aiConfig.decision.modelId")}</FieldLabel>
              <Input
                autoComplete="off"
                dir="ltr"
                disabled={disabled}
                onChange={(event) =>
                  setDecision({
                    provider: draft.provider,
                    apiKey: draft.apiKey,
                    modelId: event.target.value,
                  })
                }
                placeholder={DEFAULT_DECISION_MODEL_ID}
                spellCheck={false}
                value={draft.modelId}
              />
            </Field>
            <Button
              aria-label={tCommon("remove")}
              disabled={disabled}
              onClick={() => onStateChange({ kind: "cleared" })}
              size="icon"
              type="button"
              variant="ghost"
            >
              <Trash2Icon className="size-4" />
            </Button>
          </div>
        </div>
      )}
    </Field>
  );
};

const isDecisionProvider = (
  value: string | null,
): value is DecisionProviderValue =>
  value !== null &&
  DECISION_PROVIDER_KEYS.some((provider) => provider === value);
