import type { ReactNode } from "react";

import { CheckboxFace, FieldFace, LabelFace } from "@stll/ui/control-face";
import { SettingsPanel } from "@stll/ui/settings";

import { PendingText } from "@/components/pending-text";
import { SettingsSectionPending } from "@/routes/_protected.settings/-components/settings-section.pending";

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
  <SettingsSectionPending
    description="settings.organization.billingDrafts.description"
    title="settings.organization.billingDrafts.title"
  >
    <SettingsPanel>
      <div className="flex flex-col gap-4">{children}</div>
    </SettingsPanel>
  </SettingsSectionPending>
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
