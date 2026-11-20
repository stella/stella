import type { ReactNode } from "react";

import { ButtonFace, FaceLabelPending } from "@stll/ui/control-face";
import { SettingsPanel } from "@stll/ui/settings";
import { cn } from "@stll/ui/utils";

import { SettingsSectionPending } from "@/routes/_protected.settings/-components/settings-section.pending";

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

/** The two-factor section (`TwoFactorCard`): header, status and actions. */
export const TwoFactorCardFrame = ({
  actions,
  children,
  status,
}: TwoFactorCardFrameProps) => (
  <>
    <SettingsSectionPending
      description="settings.account.twoFactor.description"
      title="settings.account.twoFactor.title"
    >
      <SettingsPanel>
        <div className="flex flex-wrap items-center justify-between gap-4">
          {status}
          <div className="flex gap-2">{actions}</div>
        </div>
      </SettingsPanel>
    </SettingsSectionPending>
    {children}
  </>
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
