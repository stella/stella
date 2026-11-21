import type { ReactNode } from "react";

import { ButtonFace } from "@stll/ui/control-face";
import { DownloadIcon } from "@stll/ui/icons";
import { ListItemMedia } from "@stll/ui/list-shell";
import { SettingsRow, SettingsSection } from "@stll/ui/settings";

import { PendingText } from "@/components/pending-text";

type PersonalDataExportCardFrameProps = {
  /** The export's state, in one line. */
  description: ReactNode;
  /** The state's one action. */
  action: ReactNode;
  /** A failed read's notice under the row. */
  footer?: ReactNode;
};

/**
 * The data export (`PersonalDataExportCard`): one row that names the copy,
 * says where the export stands and offers its next step.
 */
export const PersonalDataExportCardFrame = ({
  action,
  description,
  footer,
}: PersonalDataExportCardFrameProps) => (
  <SettingsSection>
    <SettingsRow
      description={description}
      footer={footer}
      media={
        <ListItemMedia>
          <DownloadIcon />
        </ListItemMedia>
      }
      title={
        <PendingText
          barClassName="w-40"
          id="settings.account.personalDataExportTitle"
        />
      }
    >
      {action}
    </SettingsRow>
  </SettingsSection>
);

/** The line a member without an export reads, in both phases. */
export const PersonalDataExportDescription = () => (
  <PendingText
    barClassName="w-72 max-w-full"
    id="settings.account.personalDataExportDescription"
  />
);

/**
 * The export's action while it loads: the request button's face, which is
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

/** The row in its pending phase. */
export const PersonalDataExportCardPending = () => (
  <PersonalDataExportCardFrame
    action={<PersonalDataExportStatusPending />}
    description={<PersonalDataExportDescription />}
  />
);
