import type { ComponentProps } from "react";

import { useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { sanitizeHref } from "@stll/decision-reader/sanitize-href";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@stll/ui/alert-dialog";
import { Button } from "@stll/ui/button";

import {
  getProviderValues,
  hasUsableOpenAIKey,
  roleModelsFromOverrideModels,
} from "@/components/ai-config-role-models.logic";
import { CopyControl } from "@/components/copy-control";
import { QueryViewFeedback } from "@/components/query-view-feedback";
import { detached } from "@/lib/detached";
import { providerSetupGuidance } from "@/lib/errors/provider-setup-guidance";
import {
  aiAvailabilityOptions,
  aiConfigOptions,
} from "@/lib/organization/ai-config-queries";
import type { OrganizationAIConfig } from "@/lib/organization/ai-config-queries";
import { useCallerFeatureEnabled } from "@/lib/organization/feature-access/access";
import { CALLER_FEATURE } from "@/lib/organization/feature-access/surfaces";
import { queryView } from "@/lib/query-view.logic";
import { useQueryViewError } from "@/lib/use-query-view";
import { AIProviderRows } from "@/routes/_protected.settings/organization/-components/organization/ai-provider-rows";

import { AIConfigAdvanced } from "./ai-config-advanced";
import {
  AIConfigCardPending,
  AIConfigFormLayout,
} from "./ai-config-card.pending";
import {
  hasCustomAIModels,
  resolveProviderKeyNeed,
  sameProviderSet,
} from "./ai-config-form.logic";
import type { AIConfigFeedback } from "./ai-config-form.logic";
import { AIProviderSettingsBoundary } from "./ai-provider-settings-boundary";
import { AISettingsSectionFeedback } from "./ai-settings-section";
import { DeepLKeyCard } from "./deepl-key-card";
import { DocumentProcessingCard } from "./document-processing-card";
import { MemoryExtractionCard } from "./memory-extraction-card";
import { OrganizationInstructionsCard } from "./organization-instructions-card";
import { PromptCachingCard } from "./prompt-caching-card";
import { useAIConfigForm } from "./use-ai-config-form";
import type { AIConfigReadState } from "./use-ai-config-form";
import { VerificationDecisionModelCard } from "./verification-decision-model-card";
import { WebSearchKeysCard } from "./web-search-keys-card";

export const AIConfigCard = () => (
  <AIProviderSettingsBoundary pending={<AIConfigCardPending />}>
    <AIConfigCardContent />
  </AIProviderSettingsBoundary>
);

const AIConfigCardContent = () => {
  const activeOrganizationId = useRouteContext({
    from: "/_protected",
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const {
    data: config,
    isError,
    refetch,
  } = useQuery(aiConfigOptions({ organizationId: activeOrganizationId }));

  if (isError) {
    return (
      <AIConfigForm
        key={activeOrganizationId}
        organizationId={activeOrganizationId}
        readState={{
          status: "unreadable",
          onRetry: () => detached(refetch(), "ai-config-card.refetch"),
        }}
      />
    );
  }

  if (!config) {
    return <AIConfigCardPending />;
  }

  return (
    <AIConfigForm
      readState={{ status: "ready", config }}
      key={activeOrganizationId}
      organizationId={activeOrganizationId}
    />
  );
};

type AIConfigFormProps = {
  readState: AIConfigReadState;
  organizationId: string;
};

type AIConfigFormState = ReturnType<typeof useAIConfigForm>;

type UnreadableRecoveryProps = {
  form: AIConfigFormState;
  onRetry: () => void;
};

const UnreadableRecovery = ({ form, onRetry }: UnreadableRecoveryProps) => {
  const common = useTranslations("common");
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-destructive text-sm">{common("somethingWentWrong")}</p>
      <div className="flex items-center gap-2">
        <Button
          disabled={form.saving}
          disabledReason={common("saving")}
          onClick={onRetry}
          size="sm"
          variant="outline"
        >
          {common("retry")}
        </Button>
        <Button
          disabled={form.saving}
          disabledReason={common("saving")}
          onClick={form.toggleRecovery}
          size="sm"
          variant="ghost"
        >
          {common(form.recoveryAction === "keep" ? "remove" : "cancel")}
        </Button>
      </div>
      {form.recoveryAction === "remove" && (
        <p className="text-muted-foreground text-xs">
          {common("unsavedChanges")}
        </p>
      )}
    </div>
  );
};

type SettingsErrorProps = {
  error: Extract<AIConfigFeedback, { status: "error" }>;
};

const SettingsError = ({ error }: SettingsErrorProps) => {
  const translate = useTranslations("organization.aiConfig");
  const setupGuidance =
    error.code === undefined ? undefined : providerSetupGuidance(error.code);
  return (
    <div
      role="alert"
      className="text-destructive flex items-start gap-2 text-sm"
    >
      <div className="min-w-0 flex-1 wrap-anywhere whitespace-pre-wrap">
        <p>{error.message}</p>
        {setupGuidance && (
          <p>
            {translate(setupGuidance.guidance)}{" "}
            <a
              className="underline"
              href={sanitizeHref(setupGuidance.url)}
              target="_blank"
              rel="noreferrer"
            >
              {translate(setupGuidance.linkLabel)}
            </a>
          </p>
        )}
      </div>
      <CopyControl text={error.message} />
    </div>
  );
};

type LeaveGuardProps = {
  blocker: AIConfigFormState["blocker"];
};

const LeaveGuard = ({ blocker }: LeaveGuardProps) => {
  const common = useTranslations("common");
  return (
    <AlertDialog
      open={blocker.status === "blocked"}
      onOpenChange={(open) => {
        if (!open && blocker.status === "blocked") {
          blocker.reset();
        }
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{common("confirmAction")}</AlertDialogTitle>
          <AlertDialogDescription>
            {common("unsavedLeaveConfirm")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="ghost" />}>
            {common("goBackToEditing")}
          </AlertDialogClose>
          <Button
            onClick={() => {
              if (blocker.status === "blocked") {
                blocker.proceed();
              }
            }}
          >
            {common("confirm")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
};

/** Shown only where Anchor Verification is offered to the organization. */
const VerificationDecisionModelSection = ({
  setting,
}: {
  setting: OrganizationAIConfig["verificationDecisionModel"];
}) =>
  useCallerFeatureEnabled(CALLER_FEATURE.verification) ? (
    <VerificationDecisionModelCard setting={setting} />
  ) : null;

/** Shown only where the organization has AI memory. */
const MemoryExtractionSection = (
  props: ComponentProps<typeof MemoryExtractionCard>,
) =>
  useCallerFeatureEnabled(CALLER_FEATURE.aiMemory) ? (
    <MemoryExtractionCard {...props} />
  ) : null;

export const AIConfigForm = ({
  readState,
  organizationId,
}: AIConfigFormProps) => {
  const common = useTranslations("common");
  const form = useAIConfigForm({ readState, organizationId });
  const t = useTranslations("organization.aiConfig");
  // A failed read keeps the providers' generic line; nothing else needs it.
  const availabilityView = queryView(
    useQuery(aiAvailabilityOptions({ organizationId })),
  );
  useQueryViewError(availabilityView, "AIConfigForm:availability");
  const settingsError = form.feedback.status === "error" ? form.feedback : null;
  const providerValues = getProviderValues(form.providers);
  const { keySections, saving, toggleSections } = form;
  const keyNeed = resolveProviderKeyNeed({
    configured: form.storedProviders.length > 0,
    availability:
      availabilityView.type === "items" ? availabilityView.items : undefined,
  });
  // The effective model per mode, read only while the rows match what is
  // saved: the defaults of an unsaved provider set describe a future state.
  const roleSelections =
    form.defaultModels !== null &&
    sameProviderSet(form.providers, form.storedProviders)
      ? roleModelsFromOverrideModels({
          overrideModels: form.roleModels,
          defaultModels: form.defaultModels,
          providers: providerValues,
        })
      : null;
  const resolveAiConfigSaveDisabledReason = () => {
    if (form.saving) {
      return common("saving");
    }
    if (!form.hasChangesToSave) {
      return common("noChangesToSave");
    }
    return t("resolveErrorsBeforeSaving");
  };

  return (
    <AIConfigFormLayout
      deepl={<DeepLKeyCard {...keySections.deepl} disabled={saving} />}
      details={
        <>
          {readState.status === "ready" &&
            form.providers.length > 0 &&
            form.storedProviders.length > 0 && (
              <AIConfigAdvanced
                disabled={form.saving}
                providers={providerValues}
                hasOpenAIKey={hasUsableOpenAIKey(form.providers)}
                roleModels={form.roleModels}
                defaultModels={form.defaultModels}
                providerDefaultModels={form.providerDefaultModels}
                defaultsFeedback={
                  <QueryViewFeedback view={form.defaultsView} />
                }
                onRoleChange={form.changeRole}
                onRoleReset={form.resetRole}
                decisionState={form.decisionState}
                storedDecision={form.storedDecision}
                onDecisionChange={form.changeDecision}
                decisionInstanceProvisioned={
                  form.config?.decisionInstanceProvisioned ?? false
                }
                custom={hasCustomAIModels(form)}
              />
            )}
          {settingsError && <SettingsError error={settingsError} />}
          {form.feedback.status !== "error" && (
            <AISettingsSectionFeedback feedback={form.feedback} />
          )}
          {readState.status === "ready" && (
            <VerificationDecisionModelSection
              setting={readState.config.verificationDecisionModel}
            />
          )}
        </>
      }
      documentProcessing={
        <DocumentProcessingCard
          {...toggleSections.documentProcessing}
          disabled={saving}
        />
      }
      instructions={<OrganizationInstructionsCard />}
      memoryExtraction={
        <MemoryExtractionSection
          {...toggleSections.memoryExtraction}
          disabled={saving}
        />
      }
      promptCaching={
        <PromptCachingCard
          {...toggleSections.promptCaching}
          disabled={saving}
        />
      }
      providers={
        readState.status === "unreadable" ? (
          <UnreadableRecovery form={form} onRetry={readState.onRetry} />
        ) : (
          <AIProviderRows
            storedProviders={form.storedProviders}
            providers={form.providers}
            disabled={form.saving}
            keyNeed={keyNeed}
            roleSelections={roleSelections}
            setupErrorCode={settingsError?.code}
            onChange={form.changeProviders}
            onRemove={form.removeProvider}
          />
        )
      }
      saveAction={
        <div className="flex items-center gap-3">
          {form.hasChangesToSave && !form.saving && (
            <p className="text-muted-foreground text-xs" role="status">
              {common("unsavedChanges")}
            </p>
          )}
          <Button
            size="sm"
            disabled={!form.canClickSave || form.saving}
            disabledReason={resolveAiConfigSaveDisabledReason()}
            loading={form.saving}
            onClick={() =>
              detached(form.saveSettings(), "ai-config.save-settings")
            }
          >
            {common("saveChanges")}
          </Button>
        </div>
      }
      webSearch={
        <WebSearchKeysCard
          search={{ ...keySections.search, disabled: saving }}
          fetch={{ ...keySections.fetch, disabled: saving }}
        />
      }
    >
      <LeaveGuard blocker={form.blocker} />
    </AIConfigFormLayout>
  );
};
