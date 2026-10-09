import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Field, FieldDescription, FieldLabel } from "@stll/ui/field";
import { PlusIcon, Trash2Icon } from "@stll/ui/icons";
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
  DEFAULT_DECISION_MODEL_IDS,
} from "@/components/ai-config-role-models.logic";
import type {
  DecisionModelState,
  DecisionProviderValue,
  StoredDecisionModel,
} from "@/components/ai-config-role-models.logic";
import { SecretInput } from "@/components/secret-input";

type AIConfigDecisionModelProps = {
  disabled?: boolean;
  hasOpenAIKey: boolean;
  /** The instance carries a decision model orgs without one fall back to. */
  instanceProvisioned: boolean;
  onStateChange: (state: DecisionModelState) => void;
  state: DecisionModelState;
  stored: StoredDecisionModel | null;
};

export const AIConfigDecisionModel = ({
  disabled = false,
  hasOpenAIKey,
  instanceProvisioned,
  onStateChange,
  state,
  stored,
}: AIConfigDecisionModelProps) => {
  const t = useTranslations("organization");
  const tAuth = useTranslations("auth");
  const tCommon = useTranslations("common");
  const draft = decisionModelDraft({ state, stored });

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
                onStateChange(createDecisionModelState(value, hasOpenAIKey));
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
                    {provider === "openai" && (
                      <span className="bg-muted text-muted-foreground ms-2 rounded px-1.5 py-0.5 text-xs">
                        {tAuth("betaNoticeTitle")}
                      </span>
                    )}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </Field>

          <div className="flex min-w-0 flex-col gap-3">
            {draft.provider === "openai" && (
              <>
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
                  <FieldLabel>{t("aiConfig.dataRegion")}</FieldLabel>
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
                        {t("aiConfig.regions.global")}
                      </SelectItem>
                    </SelectPopup>
                  </Select>
                </Field>
              </>
            )}
            {(draft.provider !== "openai" || draft.keyMode === "override") && (
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
                    editDecision({ apiKey: event.target.value })
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
          </div>

          <div className="flex min-w-0 items-end gap-2">
            <Field className="min-w-0 flex-1">
              <FieldLabel>{t("aiConfig.decision.modelId")}</FieldLabel>
              <Input
                autoComplete="off"
                dir="ltr"
                disabled={disabled}
                onChange={(event) =>
                  editDecision({ modelId: event.target.value })
                }
                placeholder={DEFAULT_DECISION_MODEL_IDS[draft.provider]}
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
