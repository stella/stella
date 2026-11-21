import type { ReactNode } from "react";

import { SwitchFace } from "@stll/ui/control-face";
import { SettingsRow, SettingsSection } from "@stll/ui/settings";

import { PendingText } from "@/components/pending-text";

/*
 * The verification verdicts row (`VerificationDecisionModelControl`),
 * beside its pending phase: the switch's caption and quiet line at the
 * start, the switch at the end, and why it cannot be turned on under them.
 * The live card puts its `Label` and `Switch` in; the pending phase their
 * faces, off (the setting waits on data).
 */

type VerificationDecisionModelFrameProps = {
  /** The switch's caption. */
  label: ReactNode;
  description: ReactNode;
  /** The switch. */
  control: ReactNode;
  /** Why the switch cannot be turned on, when it cannot. */
  notice?: ReactNode;
};

/** The verification verdicts row, in both phases. */
export const VerificationDecisionModelFrame = ({
  control,
  description,
  label,
  notice,
}: VerificationDecisionModelFrameProps) => (
  <SettingsSection>
    <SettingsRow description={description} footer={notice} title={label}>
      {control}
    </SettingsRow>
  </SettingsSection>
);

/** The row while the AI configuration is read. */
export const VerificationDecisionModelCardPending = () => (
  <VerificationDecisionModelFrame
    control={<SwitchFace />}
    description={
      <PendingText
        barClassName="w-96 max-w-full"
        id="settings.organization.verificationDecisionModel.description"
      />
    }
    label={
      // The live `Label` with its `text-sm font-medium` caption.
      <span className="text-foreground inline-flex items-center gap-2 text-sm font-medium sm:text-sm/4">
        <PendingText
          barClassName="w-48"
          id="settings.organization.verificationDecisionModel.title"
        />
      </span>
    }
  />
);
