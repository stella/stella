import type { ReactNode } from "react";

import { ButtonFace, InputFace, LabelFace } from "@stll/ui/control-face";
import { Frame, FramePanel } from "@stll/ui/frame";
import { cn } from "@stll/ui/utils";

import { PendingText } from "@/components/pending-text";
import { FORM_STACK_CLASS } from "@/routes/_protected.settings/-components/settings-card.pending";

/*
 * The organization's data boxes card (`./data-boxes-card.tsx`): one line on
 * how filing follows the boxes, the boxes, then the field that adds one. The
 * card renders `OrganizationDataBoxesCardFrame`; while the boxes load, and
 * in the General page's pending phase, it is
 * `OrganizationDataBoxesCardPending`: the line and the add field's faces
 * (every member who reaches the page may edit the boxes). The boxes
 * themselves join between them once they are read; an organization without
 * any shows none.
 */

/** The add form's classes over a `Form`'s stack column. */
const DATA_BOX_ADD_FORM_CLASS = "flex flex-wrap items-end gap-2";

/** The data-box id field's width (its face holds no text, so no type). */
const DATA_BOX_INPUT_CLASS = "w-32";

/** The card in both phases: the line, then what the page puts under it. */
export const OrganizationDataBoxesCardFrame = ({
  children,
  feedback,
}: {
  /** The boxes and the add form, or the form's faces. */
  children: ReactNode;
  /** A failed refresh's notice, above the line. */
  feedback?: ReactNode;
}) => (
  <Frame>
    <FramePanel>
      <div className="flex flex-col gap-3 p-1">
        {feedback}
        <p className="text-muted-foreground text-sm">
          <PendingText
            barClassName="w-80 max-w-full"
            id="settings.organization.dataBoxes.description"
          />
        </p>
        {children}
      </div>
    </FramePanel>
  </Frame>
);

/** The card while the organization's data boxes are on their way. */
export const OrganizationDataBoxesCardPending = () => (
  <OrganizationDataBoxesCardFrame>
    {/* The live `Form`: its stack column with the add form's classes. */}
    <div className={cn(FORM_STACK_CLASS, DATA_BOX_ADD_FORM_CLASS)}>
      <div className="flex flex-col gap-1">
        <LabelFace>
          <PendingText
            barClassName="w-20"
            id="contacts.communication.dataBoxPlaceholder"
          />
        </LabelFace>
        <InputFace className={DATA_BOX_INPUT_CLASS} />
      </div>
      <ButtonFace className="min-h-11" size="default" variant="default">
        <PendingText barClassName="w-8" id="common.add" />
      </ButtonFace>
    </div>
  </OrganizationDataBoxesCardFrame>
);
