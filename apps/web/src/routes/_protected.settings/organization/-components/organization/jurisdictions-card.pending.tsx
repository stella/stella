import type { ReactNode } from "react";

import { SettingsPanel, SettingsSection } from "@stll/ui/settings";

import { PendingText } from "@/components/pending-text";
import { JurisdictionPickerPending } from "@/features/organization/components/jurisdiction-picker.pending";

/*
 * The practice jurisdictions card (`./jurisdictions-card.tsx`): one line on
 * what the choice is for, over the picker. The card renders
 * `OrganizationJurisdictionsCardFrame` with the live picker; while the
 * organization's settings load, and in the General page's pending phase, it
 * is `OrganizationJurisdictionsCardPending`, the picker's face in the same
 * box.
 */

/** The card in both phases: the line over the picker. */
export const OrganizationJurisdictionsCardFrame = ({
  children,
  feedback,
}: {
  /** The picker, or its face. */
  children: ReactNode;
  /** A failed refresh's notice, above the line. */
  feedback?: ReactNode;
}) => (
  <SettingsSection>
    <SettingsPanel>
      <div className="flex flex-col gap-3">
        {feedback}
        <p className="text-muted-foreground text-sm">
          <PendingText
            barClassName="w-72 max-w-full"
            id="settings.organization.practiceJurisdictionsDescription"
          />
        </p>
        {children}
      </div>
    </SettingsPanel>
  </SettingsSection>
);

/** The card while the organization's jurisdictions are on their way. */
export const OrganizationJurisdictionsCardPending = () => (
  <OrganizationJurisdictionsCardFrame>
    <JurisdictionPickerPending />
  </OrganizationJurisdictionsCardFrame>
);
