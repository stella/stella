import type { ReactNode } from "react";

import { FaceLabelPending, FieldTriggerFace } from "@stll/ui/control-face";
import { SettingsPanel, SettingsSection } from "@stll/ui/settings";

import { PendingText } from "@/components/pending-text";

/*
 * The organization's time zone card (`./time-zone-card.tsx`): one line on
 * what the zone governs, over its picker. The card renders
 * `OrganizationTimeZoneCardFrame` with the live picker; while the
 * organization's settings load, and in the General page's pending phase, it
 * is `OrganizationTimeZoneCardPending`, the picker's trigger face with a bar
 * where the zone will be.
 */

/** The card in both phases: the line over the picker. */
export const OrganizationTimeZoneCardFrame = ({
  children,
}: {
  /** The picker (with its hidden caption), or its face. */
  children: ReactNode;
}) => (
  <SettingsSection>
    <SettingsPanel>
      <div className="flex flex-col gap-3">
        <p className="text-muted-foreground text-sm">
          <PendingText
            barClassName="w-80 max-w-full"
            id="settings.organization.timeZone.description"
          />
        </p>
        {children}
      </div>
    </SettingsPanel>
  </SettingsSection>
);

/** The card while the organization's settings are on their way. */
export const OrganizationTimeZoneCardPending = () => (
  <OrganizationTimeZoneCardFrame>
    <FieldTriggerFace>
      <FaceLabelPending className="w-48" />
    </FieldTriggerFace>
  </OrganizationTimeZoneCardFrame>
);
