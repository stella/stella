import type { ReactNode } from "react";

import { ButtonFace, InputFace } from "@stll/ui/control-face";
import { Frame, FramePanel } from "@stll/ui/frame";
import { PlusIcon } from "@stll/ui/icons";

import { PendingText } from "@/components/pending-text";

/*
 * The organization's data boxes card (`./data-boxes-card.tsx`): one line on
 * how filing follows the boxes, the boxes, then one row with the field that
 * adds one and its button. The card renders `OrganizationDataBoxesCardFrame`;
 * while the boxes load, and in the General page's pending phase, it is
 * `OrganizationDataBoxesCardPending`: the line and the add field's faces
 * (every member who reaches the page may edit the boxes). The boxes
 * themselves join between them once they are read; an organization without
 * any shows none.
 */

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
    {/* The live `Form`, compact and inline: one row. */}
    <div className="flex w-full flex-row items-center gap-2">
      <InputFace className="max-w-48">
        <PendingText
          barClassName="w-20"
          id="contacts.communication.dataBoxPlaceholder"
        />
      </InputFace>
      <ButtonFace size="default" variant="default">
        <PlusIcon />
        <PendingText barClassName="w-8" id="common.add" />
      </ButtonFace>
    </div>
  </OrganizationDataBoxesCardFrame>
);
