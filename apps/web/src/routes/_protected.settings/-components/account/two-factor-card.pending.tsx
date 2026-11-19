import type { ReactNode } from "react";

import { ButtonFace, FaceLabelPending } from "@stll/ui/control-face";
import { FramePanel } from "@stll/ui/frame";
import { cn } from "@stll/ui/utils";

import { SettingsCardPending } from "@/routes/_protected.settings/-components/settings-card.pending";

/** The status chip's box; the page adds its tone (on, off). */
export const TWO_FACTOR_STATUS_CLASS =
  "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium";

type TwoFactorCardFrameProps = {
  /** Whether two-factor sign-in is on, as a chip. */
  status: ReactNode;
  /** Turning it on or off, and the backup codes. */
  actions: ReactNode;
  /** What the card mounts beside its panel (its dialogs). */
  children?: ReactNode;
};

/** The two-factor card (`TwoFactorCard`): header, status and actions. */
export const TwoFactorCardFrame = ({
  actions,
  children,
  status,
}: TwoFactorCardFrameProps) => (
  <SettingsCardPending
    description="settings.account.twoFactor.description"
    title="settings.account.twoFactor.title"
  >
    <FramePanel>
      <div className="flex items-center justify-between gap-4 p-4">
        {status}
        <div className="flex gap-2">{actions}</div>
      </div>
    </FramePanel>
    {children}
  </SettingsCardPending>
);

/** The card while the session loads: the chip and the action as faces. */
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
