import type { ReactNode } from "react";

import { ButtonFace } from "@stll/ui/control-face";

import { PendingText } from "@/components/pending-text";
import { SettingsPageHeaderPending } from "@/routes/_protected.settings/-components/settings-page-header.pending";

import {
  DeepLKeyCardPending,
  WebSearchKeysCardPending,
} from "./ai-key-card.pending";
import { AIProviderRowsPending } from "./ai-provider-rows.pending";
import {
  AIToggleCardPending,
  DOCUMENT_PROCESSING_CARD,
  PROMPT_CACHING_CARD,
} from "./ai-toggle-card.pending";
import { OrganizationInstructionsCardPending } from "./organization-instructions-card.pending";

/*
 * The AI provider settings (`AIConfigForm`), beside its pending phase: the
 * heading with its save action, the providers, what follows from them (the
 * role models, the save's feedback, the verification model), the
 * organization's instructions, the on/off cards, then the DeepL and web
 * search keys, each set apart by a rule. The live form fills the slots; the
 * pending phase draws what every organization manager sees, and leaves out
 * what depends on the stored providers or on a feature (the role models,
 * the verification model, memory extraction), which joins once read.
 */

type AIConfigFormLayoutProps = {
  /** The heading's save button, or its face. */
  saveAction: ReactNode;
  /** The providers group (or the unreadable configuration's recovery). */
  providers: ReactNode;
  /** What follows from the providers: role models, feedback, verification. */
  details?: ReactNode;
  instructions: ReactNode;
  promptCaching: ReactNode;
  documentProcessing: ReactNode;
  /** Shown where the organization has AI memory. */
  memoryExtraction?: ReactNode;
  deepl: ReactNode;
  webSearch: ReactNode;
  /** What the form mounts beside its sections (the leave guard). */
  children?: ReactNode;
};

/** The AI provider settings in both phases. */
export const AIConfigFormLayout = ({
  children,
  deepl,
  details,
  documentProcessing,
  instructions,
  memoryExtraction,
  promptCaching,
  providers,
  saveAction,
  webSearch,
}: AIConfigFormLayoutProps) => (
  <div className="flex flex-col gap-4">
    <SettingsPageHeaderPending
      action={saveAction}
      description="settings.organization.aiDescription"
      title="settings.organization.ai"
    />
    {providers}
    {details}
    {instructions}
    {promptCaching}
    {documentProcessing}
    {memoryExtraction}
    <div className="my-8 border-t" />
    {deepl}
    <div className="my-8 border-t" />
    {webSearch}
    {children}
  </div>
);

/** The AI provider settings while the configuration is read. */
export const AIConfigCardPending = () => (
  <AIConfigFormLayout
    deepl={<DeepLKeyCardPending />}
    documentProcessing={<AIToggleCardPending {...DOCUMENT_PROCESSING_CARD} />}
    instructions={<OrganizationInstructionsCardPending />}
    promptCaching={<AIToggleCardPending {...PROMPT_CACHING_CARD} />}
    providers={<AIProviderRowsPending />}
    saveAction={
      <ButtonFace size="sm" variant="default">
        <PendingText barClassName="w-20" id="common.saveChanges" />
      </ButtonFace>
    }
    webSearch={<WebSearchKeysCardPending />}
  />
);
