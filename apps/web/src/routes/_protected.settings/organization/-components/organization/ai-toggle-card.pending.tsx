import type { ReactNode } from "react";

import { SwitchFace } from "@stll/ui/control-face";
import { SettingsRow } from "@stll/ui/settings";

import { PendingText } from "@/components/pending-text";
import type { PendingTextKey } from "@/components/pending-text";

/*
 * The AI page's on/off settings (prompt caching, document processing,
 * memory extraction), each beside its pending phase: one row of the page's
 * on/off section (`AIConfigFormLayout`) with the setting's title and its one
 * quiet line, the checkbox at its end. The live row puts its checkbox in the
 * toggle slot, named by the row's title (`settingsRowIds(copy.id)`); the
 * pending phase the checkbox's face, unticked (the setting waits on data).
 */

type AIToggleCardFrameProps = {
  /** Names the row's title and line (`settingsRowIds`). */
  id: string;
  title: PendingTextKey;
  description: PendingTextKey;
  /** The checkbox, or its face. */
  toggle: ReactNode;
  /** A failed refetch's line, under the row; none while the read is fine. */
  notice?: ReactNode;
  /** The row's save feedback, under it; none while idle. */
  children?: ReactNode;
};

/** An AI on/off setting's row in both phases. */
export const AIToggleCardFrame = ({
  children,
  description,
  id,
  notice,
  title,
  toggle,
}: AIToggleCardFrameProps) => (
  <SettingsRow
    description={
      <PendingText barClassName="w-80 max-w-full" id={description} />
    }
    footer={
      notice === undefined && children === undefined ? undefined : (
        <>
          {notice}
          {children}
        </>
      )
    }
    id={id}
    interaction="label"
    title={<PendingText barClassName="w-32" id={title} />}
  >
    {toggle}
  </SettingsRow>
);

/** An AI on/off setting while its value loads. */
export const AIToggleCardPending = ({
  description,
  id,
  title,
}: AIToggleCardCopy) => (
  <AIToggleCardFrame
    description={description}
    id={id}
    title={title}
    toggle={<SwitchFace />}
  />
);

/** An on/off setting's copy: its row id, its title, its quiet line. */
type AIToggleCardCopy = {
  id: string;
  title: PendingTextKey;
  description: PendingTextKey;
};

/** Prompt caching's copy. */
export const PROMPT_CACHING_CARD = {
  id: "ai-prompt-caching",
  title: "settings.organization.promptCaching.title",
  description: "settings.organization.promptCaching.description",
} as const satisfies AIToggleCardCopy;

/** Document processing's copy. */
export const DOCUMENT_PROCESSING_CARD = {
  id: "ai-document-processing",
  title: "settings.organization.documentProcessing.title",
  description: "settings.organization.documentProcessing.description",
} as const satisfies AIToggleCardCopy;

/** Memory extraction's copy. */
export const MEMORY_EXTRACTION_CARD = {
  id: "ai-memory-extraction",
  title: "settings.organization.memoryExtraction.title",
  description: "settings.organization.memoryExtraction.description",
} as const satisfies AIToggleCardCopy;
