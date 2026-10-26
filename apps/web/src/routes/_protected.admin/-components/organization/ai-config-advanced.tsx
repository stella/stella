import type { ReactNode } from "react";

import { useTranslations } from "use-intl";

import {
  Accordion,
  AccordionItem,
  AccordionPanel,
  AccordionTrigger,
} from "@stll/ui/accordion";

import { AIConfigRoleModelPicker } from "@/components/ai-config-role-model-picker";
import {
  hasUsableDecisionModel,
  roleModelsFromOverrideModels,
} from "@/components/ai-config-role-models.logic";
import type {
  DecisionModelState,
  ModelSelection,
  ProviderDefaultRoleModels,
  ProviderValue,
  RoleModelOverrides,
  RoleModelSelections,
  RoleValue,
  StoredDecisionModel,
} from "@/components/ai-config-role-models.logic";

import { AIConfigDecisionModel } from "./ai-config-decision-model";

type AIConfigAdvancedProps = {
  disabled: boolean;
  hasOpenAIKey: boolean;
  providers: readonly ProviderValue[];
  roleModels: RoleModelOverrides;
  defaultModels: RoleModelSelections | null;
  providerDefaultModels: ProviderDefaultRoleModels;
  defaultsFeedback: ReactNode;
  onRoleChange: (role: RoleValue, selection: ModelSelection | null) => void;
  onRoleReset: (role: RoleValue) => void;
  decisionState: DecisionModelState;
  storedDecision: StoredDecisionModel | null;
  onDecisionChange: (state: DecisionModelState) => void;
  decisionInstanceProvisioned: boolean;
  custom: boolean;
};

export const AIConfigAdvanced = ({
  disabled,
  hasOpenAIKey,
  providers,
  roleModels,
  defaultModels,
  providerDefaultModels,
  defaultsFeedback,
  onRoleChange,
  onRoleReset,
  decisionState,
  storedDecision,
  onDecisionChange,
  decisionInstanceProvisioned,
  custom,
}: AIConfigAdvancedProps) => {
  const t = useTranslations("organization");
  const common = useTranslations("common");
  const providerValues = providers;
  return (
    <Accordion>
      <AccordionItem value="advanced">
        <AccordionTrigger>
          <span>{common("advanced")}</span>
          {custom && (
            <span className="text-muted-foreground ms-auto">
              {common("custom")}
            </span>
          )}
        </AccordionTrigger>
        <AccordionPanel>
          <div className="flex flex-col gap-4">
            {defaultsFeedback}
            <AIConfigRoleModelPicker
              disabled={disabled}
              providers={providerValues}
              providerDefaultModels={providerDefaultModels}
              roleModels={
                defaultModels === null
                  ? null
                  : roleModelsFromOverrideModels({
                      overrideModels: roleModels,
                      defaultModels,
                      providers: providerValues,
                    })
              }
              customization={{ overrides: roleModels, onReset: onRoleReset }}
              onModelChange={onRoleChange}
            >
              <AIConfigDecisionModel
                disabled={disabled}
                hasOpenAIKey={hasOpenAIKey}
                instanceProvisioned={decisionInstanceProvisioned}
                onStateChange={onDecisionChange}
                state={decisionState}
                stored={storedDecision}
              />
            </AIConfigRoleModelPicker>

            {!hasUsableDecisionModel({
              state: decisionState,
              stored: storedDecision,
              hasOpenAIKey,
            }) && (
              <p className="text-destructive text-xs">
                {t("aiConfig.decision.incomplete")}
              </p>
            )}
          </div>
        </AccordionPanel>
      </AccordionItem>
    </Accordion>
  );
};
