import type { ReactNode } from "react";

import { ButtonFace, FaceLabelPending } from "@stll/ui/control-face";
import { SettingsPanel, SettingsSection } from "@stll/ui/settings";

import { PendingText } from "@/components/pending-text";

/*
 * The organization's AI instructions card, beside its pending phase: the
 * title and quiet line, the editor's bordered box (`min-h-40`, so the
 * editor that loads into it never changes the card's height), the
 * character count, then the card's lines and actions. The live card fills
 * the slots with the editor and its controls; the pending phase leaves the
 * box empty, a bar on the count's line and the actions' faces.
 */

type OrganizationInstructionsCardFrameProps = {
  /** Ids that name the editor's group, in the live card. */
  headingId?: string | undefined;
  descriptionId?: string | undefined;
  /** The editor, inside its box. */
  editor?: ReactNode;
  /** The line that counts the characters, formatted. */
  lengthLine: ReactNode;
  /** The lines and actions under the count (a too-long alert, save). */
  children?: ReactNode;
};

/** The instructions card in both phases. */
export const OrganizationInstructionsCardFrame = ({
  lengthLine,
  children,
  descriptionId,
  editor,
  headingId,
}: OrganizationInstructionsCardFrameProps) => (
  <SettingsSection
    description={
      <span id={descriptionId}>
        <PendingText
          barClassName="w-80 max-w-full"
          id="organization.aiInstructions.description"
        />
      </span>
    }
    title={
      <span id={headingId}>
        <PendingText
          barClassName="w-36"
          id="organization.aiInstructions.title"
        />
      </span>
    }
  >
    <SettingsPanel>
      <div className="flex flex-col gap-3">
        <div
          aria-describedby={descriptionId}
          aria-labelledby={headingId}
          // The editor loads lazily into this box and fills it, so its
          // arrival never changes the card's height.
          className="flex min-h-40 flex-col rounded-md border"
          role={editor === undefined ? undefined : "group"}
        >
          {editor}
        </div>
        <p className="text-muted-foreground text-end text-xs tabular-nums">
          {lengthLine}
        </p>
        {children}
      </div>
    </SettingsPanel>
  </SettingsSection>
);

/** The card's save and remove actions' row. */
export const ORGANIZATION_INSTRUCTIONS_ACTIONS_CLASS =
  "flex items-center gap-2";

/**
 * The instructions card while the settings load: the editor's empty box,
 * the count's bar and the actions an organization manager has.
 */
export const OrganizationInstructionsCardPending = () => (
  <OrganizationInstructionsCardFrame
    lengthLine={<FaceLabelPending className="w-20" />}
  >
    <div className={ORGANIZATION_INSTRUCTIONS_ACTIONS_CLASS}>
      <ButtonFace size="sm" variant="default">
        <PendingText barClassName="w-8" id="common.save" />
      </ButtonFace>
      <ButtonFace size="sm" variant="ghost">
        <PendingText barClassName="w-12" id="common.remove" />
      </ButtonFace>
    </div>
  </OrganizationInstructionsCardFrame>
);
