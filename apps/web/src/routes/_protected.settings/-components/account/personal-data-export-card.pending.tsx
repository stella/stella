import type { ReactNode } from "react";

import { ButtonFace } from "@stll/ui/control-face";
import { SettingsPanel } from "@stll/ui/settings";

import { PendingText } from "@/components/pending-text";
import { SettingsSectionPending } from "@/routes/_protected.settings/-components/settings-section.pending";

/** The data export section (`PersonalDataExportCard`): header and panel. */
export const PersonalDataExportCardFrame = ({
  children,
}: {
  children: ReactNode;
}) => (
  <SettingsSectionPending
    description="settings.account.personalDataExportDescription"
    title="settings.account.personalDataExportTitle"
  >
    <SettingsPanel>
      <div className="flex flex-col items-start gap-3">{children}</div>
    </SettingsPanel>
  </SettingsSectionPending>
);

/**
 * The export's state while it loads: the request button's face, which is
 * what a member without an export sees (one with an export sees its status).
 */
export const PersonalDataExportStatusPending = () => (
  <ButtonFace size="sm" variant="outline">
    <PendingText
      barClassName="w-24"
      id="settings.account.personalDataExportRequest"
    />
  </ButtonFace>
);

/** The section in its pending phase. */
export const PersonalDataExportCardPending = () => (
  <PersonalDataExportCardFrame>
    <PersonalDataExportStatusPending />
  </PersonalDataExportCardFrame>
);
