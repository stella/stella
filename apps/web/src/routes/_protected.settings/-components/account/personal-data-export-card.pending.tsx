import type { ReactNode } from "react";

import { ButtonFace } from "@stll/ui/control-face";
import { FramePanel } from "@stll/ui/frame";

import { PendingText } from "@/components/pending-text";
import { SettingsCardPending } from "@/routes/_protected.settings/-components/settings-card.pending";

/** The data export card (`PersonalDataExportCard`): header and panel. */
export const PersonalDataExportCardFrame = ({
  children,
}: {
  children: ReactNode;
}) => (
  <SettingsCardPending
    description="settings.account.personalDataExportDescription"
    title="settings.account.personalDataExportTitle"
  >
    <FramePanel>
      <div className="flex flex-col items-start gap-3 p-4">{children}</div>
    </FramePanel>
  </SettingsCardPending>
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

/** The card in its pending phase. */
export const PersonalDataExportCardPending = () => (
  <PersonalDataExportCardFrame>
    <PersonalDataExportStatusPending />
  </PersonalDataExportCardFrame>
);
