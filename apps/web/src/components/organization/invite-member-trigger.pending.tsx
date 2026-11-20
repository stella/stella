import type { ReactNode } from "react";

import { ButtonFace } from "@stll/ui/control-face";
import { UserPlusIcon } from "@stll/ui/icons";

import { PendingText } from "@/components/pending-text";

export const INVITE_MEMBER_BUTTON_SIZE = "sm";
export const INVITE_MEMBER_BUTTON_VARIANT = "outline";

export const InviteMemberTriggerContent = ({
  label,
  showIcon = true,
}: {
  label: ReactNode;
  showIcon?: boolean;
}) => (
  <>
    {showIcon && <UserPlusIcon className="size-4" />}
    {label}
  </>
);

export const InviteMemberTriggerFace = () => (
  <ButtonFace
    size={INVITE_MEMBER_BUTTON_SIZE}
    variant={INVITE_MEMBER_BUTTON_VARIANT}
  >
    <InviteMemberTriggerContent
      label={<PendingText id="common.invite" barClassName="w-10" />}
    />
  </ButtonFace>
);
