import type { ReactNode } from "react";

import { CheckboxFace, FieldFace, LabelFace } from "@stll/ui/control-face";
import { Frame, FramePanel } from "@stll/ui/frame";

import { PendingText } from "@/components/pending-text";

/*
 * The billing drafts card (`BillingDraftsCard`), beside its pending phase:
 * its title and quiet line over the card's controls. The live card puts its
 * switch, client picker and knowledge files in; the pending phase the
 * switch's face, unticked, while the configuration is read.
 */

/** The billing drafts card in both phases. */
export const BillingDraftsCardFrame = ({
  children,
}: {
  /** The card's controls under its heading. */
  children: ReactNode;
}) => (
  <Frame>
    <FramePanel>
      <div className="flex flex-col gap-4">
        <h2 className="text-sm font-medium">
          <PendingText
            barClassName="w-32"
            id="settings.organization.billingDrafts.title"
          />
        </h2>
        <p className="text-muted-foreground text-xs">
          <PendingText
            barClassName="w-80 max-w-full"
            id="settings.organization.billingDrafts.description"
          />
        </p>
        {children}
      </div>
    </FramePanel>
  </Frame>
);

/** The billing drafts card while its configuration is read. */
export const BillingDraftsCardPending = () => (
  <BillingDraftsCardFrame>
    <FieldFace layout="inline">
      <CheckboxFace />
      <LabelFace>
        <PendingText
          barClassName="w-32"
          id="settings.organization.billingDrafts.title"
        />
      </LabelFace>
    </FieldFace>
  </BillingDraftsCardFrame>
);
