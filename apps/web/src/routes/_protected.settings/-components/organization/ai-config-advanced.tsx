import { useTranslations } from "use-intl";

import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionPanel,
} from "@stll/ui/accordion";
import { Button } from "@stll/ui/button";

import { AIConfigRoleModelPicker } from "@/components/ai-config-role-model-picker";
import {
  hasUsableDecisionModel,
  roleModelsFromOverrideModels,
} from "@/components/ai-config-role-models.logic";
import type {
  RoleModelOverrides,
  ProviderValue,
  RoleValue,
  ModelSelection,
  DecisionModelState,
  StoredDecisionModel,
} from "@/components/ai-config-role-models.logic";
import { CopyActionButton } from "@/components/copy-action-button";

import { AIConfigDecisionModel } from "./ai-config-decision-model";

type AIConfigAdvancedProps = {
  disabled: boolean;
  providers: readonly ProviderValue[];
  roleModels: RoleModelOverrides;
  onRoleChange: (role: RoleValue, selection: ModelSelection | null) => void;
  onRoleReset: (role: RoleValue) => void;
  decisionState: DecisionModelState;
  storedDecision: StoredDecisionModel | null;
  onDecisionChange: (state: DecisionModelState) => void;
  decisionInstanceProvisioned: boolean;
  canSave: boolean;
  onSave: () => void;
  settingsError: string | null;
  custom: boolean;
};

export const AIConfigAdvanced = ({
  disabled,
  providers,
  roleModels,
  onRoleChange,
  onRoleReset,
  decisionState,
  storedDecision,
  onDecisionChange,
  decisionInstanceProvisioned,
  canSave,
  onSave,
  settingsError,
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
            <AIConfigRoleModelPicker
              disabled={disabled}
              providers={providerValues}
              roleModels={roleModelsFromOverrideModels({
                overrideModels: roleModels,
                providers: providerValues,
              })}
              customization={{ overrides: roleModels, onReset: onRoleReset }}
              onModelChange={onRoleChange}
            />
            <AIConfigDecisionModel
              disabled={disabled}
              instanceProvisioned={decisionInstanceProvisioned}
              onStateChange={onDecisionChange}
              state={decisionState}
              stored={storedDecision}
            />
            {!hasUsableDecisionModel({
              state: decisionState,
              stored: storedDecision,
            }) && (
              <p className="text-destructive text-xs">
                {t("aiConfig.decision.incomplete")}
              </p>
            )}
            <Button
              className="self-start"
              size="sm"
              disabled={!canSave || disabled}
              onClick={onSave}
            >
              {common("saveChanges")}
            </Button>
            {settingsError && (
              <div
                role="alert"
                className="text-destructive flex items-start gap-2 text-sm"
              >
                <p className="min-w-0 flex-1 wrap-anywhere whitespace-pre-wrap">
                  {settingsError}
                </p>
                <CopyActionButton text={settingsError} />
              </div>
            )}
          </div>
        </AccordionPanel>
      </AccordionItem>
    </Accordion>
  );
};
