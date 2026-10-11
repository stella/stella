import { useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { sanitizeHref } from "@stll/decision-reader/sanitize-href";
import {
  AlertDialog,
  AlertDialogPopup,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogClose,
} from "@stll/ui/alert-dialog";
import { Button } from "@stll/ui/button";

import { getProviderValues } from "@/components/ai-config-role-models.logic";
import { CopyActionButton } from "@/components/copy-action-button";
import { env } from "@/env";
import { detached } from "@/lib/detached";
import { providerSetupGuidance } from "@/lib/errors/provider-setup-guidance";
import { aiConfigOptions } from "@/lib/organization/ai-config-queries";
import { AIProviderRows } from "@/routes/_protected.settings/-components/organization/ai-provider-rows";

import { SettingsPageHeader } from "../settings-page-header";
import { AIConfigAdvanced } from "./ai-config-advanced";
import { hasCustomAIModels } from "./ai-config-form.logic";
import type { AIConfigFeedback } from "./ai-config-form.logic";
import { AISettingsSectionFeedback } from "./ai-settings-section";
import { DeepLKeyCard } from "./deepl-key-card";
import { DocumentProcessingCard } from "./document-processing-card";
import { MemoryExtractionCard } from "./memory-extraction-card";
import { PromptCachingCard } from "./prompt-caching-card";
import { useAIConfigForm } from "./use-ai-config-form";
import type { AIConfigReadState } from "./use-ai-config-form";
import { WebSearchKeysCard } from "./web-search-keys-card";

export const AIConfigCard = () => {
  const t = useTranslations();
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
    return (
      <SettingsPageHeader
        title={t("settings.organization.ai")}
        description={t("settings.organization.aiDescription")}
      />
    );
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
          onClick={onRetry}
          size="sm"
          variant="outline"
        >
          {common("retry")}
        </Button>
        <Button
          disabled={form.saving}
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
  const translate = useTranslations();
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
      <CopyActionButton text={error.message} />
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

type AuxiliaryCardsProps = {
  form: AIConfigFormState;
};

const AuxiliaryCards = ({
  form: { toggleSections, keySections, saving },
}: AuxiliaryCardsProps) => (
  <>
    <PromptCachingCard {...toggleSections.promptCaching} disabled={saving} />
    <DocumentProcessingCard
      {...toggleSections.documentProcessing}
      disabled={saving}
    />
    {env.VITE_FEATURE_AI_MEMORY && (
      <MemoryExtractionCard
        {...toggleSections.memoryExtraction}
        disabled={saving}
      />
    )}
    <div className="my-8 border-t" />
    <DeepLKeyCard {...keySections.deepl} disabled={saving} />
    <div className="my-8 border-t" />
    <WebSearchKeysCard
      search={{ ...keySections.search, disabled: saving }}
      fetch={{ ...keySections.fetch, disabled: saving }}
    />
  </>
);

export const AIConfigForm = ({
  readState,
  organizationId,
}: AIConfigFormProps) => {
  const common = useTranslations("common");
  const page = useTranslations("settings.organization");
  const form = useAIConfigForm({ readState, organizationId });
  const settingsError = form.feedback.status === "error" ? form.feedback : null;
  const providerValues = getProviderValues(form.providers);
  return (
    <div className="flex flex-col gap-4">
      <SettingsPageHeader
        title={page("ai")}
        description={page("aiDescription")}
        action={
          <Button
            size="sm"
            disabled={!form.canClickSave || form.saving}
            loading={form.saving}
            onClick={() =>
              detached(form.saveSettings(), "ai-config.save-settings")
            }
          >
            {common("saveChanges")}
          </Button>
        }
      />
      {readState.status === "unreadable" ? (
        <UnreadableRecovery form={form} onRetry={readState.onRetry} />
      ) : (
        <AIProviderRows
          storedProviders={form.storedProviders}
          providers={form.providers}
          disabled={form.saving}
          setupErrorCode={settingsError?.code}
          onChange={form.changeProviders}
          onRemove={form.removeProvider}
        />
      )}
      {readState.status === "ready" &&
        form.providers.length > 0 &&
        form.storedProviders.length > 0 && (
          <AIConfigAdvanced
            disabled={form.saving}
            providers={providerValues}
            roleModels={form.roleModels}
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
      <AuxiliaryCards form={form} />
      <LeaveGuard blocker={form.blocker} />
    </div>
  );
};
