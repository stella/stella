import type { ReactNode } from "react";

import { CheckboxFace, FieldFace, LabelFace } from "@stll/ui/control-face";
import { Frame, FramePanel } from "@stll/ui/frame";

import { PendingText } from "@/components/pending-text";
import type { PendingTextKey } from "@/components/pending-text";

/*
 * The AI page's on/off cards (prompt caching, document processing, memory
 * extraction), each beside its pending phase: a `Frame` whose panel holds
 * the card's title, its one quiet line and the checkbox with its caption.
 * The live card puts its `Field` in the toggle slot; the pending phase the
 * checkbox's face, unticked (the setting waits on data).
 */

type AIToggleCardFrameProps = {
  title: PendingTextKey;
  description: PendingTextKey;
  /** The checkbox's field, or its face. */
  toggle: ReactNode;
  /** A failed refetch's line, above the panel. */
  notice?: ReactNode;
  /** What follows the toggle (the section's save feedback). */
  children?: ReactNode;
};

/** An AI on/off card in both phases. */
export const AIToggleCardFrame = ({
  children,
  description,
  notice,
  title,
  toggle,
}: AIToggleCardFrameProps) => (
  <Frame>
    {notice}
    <FramePanel>
      <div className="flex flex-col gap-3 p-1">
        <h2 className="text-sm font-medium">
          <PendingText barClassName="w-32" id={title} />
        </h2>
        <p className="text-muted-foreground text-xs">
          <PendingText barClassName="w-80 max-w-full" id={description} />
        </p>
        {toggle}
        {children}
      </div>
    </FramePanel>
  </Frame>
);

/** An AI on/off card while its setting loads. */
export const AIToggleCardPending = ({
  description,
  label,
  title,
}: {
  title: PendingTextKey;
  description: PendingTextKey;
  /** The checkbox's caption. */
  label: PendingTextKey;
}) => (
  <AIToggleCardFrame
    description={description}
    title={title}
    toggle={
      <FieldFace layout="inline">
        <CheckboxFace />
        <LabelFace>
          <PendingText barClassName="w-40" id={label} />
        </LabelFace>
      </FieldFace>
    }
  />
);

/** An on/off card's copy: its title, its quiet line, its toggle's caption. */
type AIToggleCardCopy = {
  title: PendingTextKey;
  description: PendingTextKey;
  label: PendingTextKey;
};

/** Prompt caching's card copy. */
export const PROMPT_CACHING_CARD = {
  title: "settings.organization.promptCaching.title",
  description: "settings.organization.promptCaching.description",
  label: "settings.organization.promptCaching.toggleLabel",
} as const satisfies AIToggleCardCopy;

/** Document processing's card copy. */
export const DOCUMENT_PROCESSING_CARD = {
  title: "settings.organization.documentProcessing.title",
  description: "settings.organization.documentProcessing.description",
  label: "settings.organization.documentProcessing.toggleLabel",
} as const satisfies AIToggleCardCopy;

/** Memory extraction's card copy. */
export const MEMORY_EXTRACTION_CARD = {
  title: "settings.organization.memoryExtraction.title",
  description: "settings.organization.memoryExtraction.description",
  label: "settings.organization.memoryExtraction.toggleLabel",
} as const satisfies AIToggleCardCopy;
