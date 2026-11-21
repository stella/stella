import type { ReactNode } from "react";

import { ButtonFace, FaceLabelPending } from "@stll/ui/control-face";
import { LockIcon } from "@stll/ui/icons";
import { ListItemMedia } from "@stll/ui/list-shell";
import { SettingsRow, SettingsSection } from "@stll/ui/settings";
import { cn } from "@stll/ui/utils";

import { PendingText } from "@/components/pending-text";

/** The status chip's box; the page adds its tone (on, off). */
export const TWO_FACTOR_STATUS_CLASS =
  "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium";

type TwoFactorCardFrameProps = {
  /** Whether two-factor sign-in is on, as a chip. */
  status: ReactNode;
  /** Turning it on or off, and the backup codes. */
  actions: ReactNode;
  /** What the section mounts beside its panel (its dialogs). */
  children?: ReactNode;
};

/** The two-factor section's anchor; the security summary links it. */
export const TWO_FACTOR_SECTION_ID = "two-factor";

/** The two-factor section (`TwoFactorCard`): header, status and actions. */
export const TwoFactorCardFrame = ({
  actions,
  children,
  status,
}: TwoFactorCardFrameProps) => (
  <div className="scroll-mt-6" id={TWO_FACTOR_SECTION_ID}>
    <SettingsSection>
      <SettingsRow
        description={
          <PendingText
            barClassName="w-72 max-w-full"
            id="settings.account.twoFactor.description"
          />
        }
        media={
          <ListItemMedia>
            <LockIcon />
          </ListItemMedia>
        }
        title={
          <PendingText
            barClassName="w-36"
            id="settings.account.twoFactor.title"
          />
        }
      >
        {status}
        {actions}
      </SettingsRow>
    </SettingsSection>
    {children}
  </div>
);

/** The section while the session loads: the chip and the action as faces. */
export const TwoFactorCardPending = () => (
  <TwoFactorCardFrame
    actions={
      <ButtonFace size="sm" variant="outline">
        <FaceLabelPending className="w-16" />
      </ButtonFace>
    }
    status={
      <span className={cn(TWO_FACTOR_STATUS_CLASS, "bg-muted")}>
        <FaceLabelPending className="w-12" />
      </span>
    }
  />
);
