import type { ComponentType, PropsWithChildren, ReactNode } from "react";

import { ButtonFace } from "@stll/ui/control-face";
import { InputOTPGroup, InputOTPSlotFace } from "@stll/ui/input-otp-face";

import { PendingText } from "@/components/pending-text";

const AUTH_CODE_SLOT_INDEXES = [0, 1, 2, 3, 4, 5];
export const AUTH_CODE_LENGTH = AUTH_CODE_SLOT_INDEXES.length;

export const AuthCodeSlots = ({
  Slot,
}: {
  Slot?: ComponentType<{ index: number }>;
}) => (
  <InputOTPGroup>
    {AUTH_CODE_SLOT_INDEXES.map((index) =>
      Slot ? (
        <Slot index={index} key={index} />
      ) : (
        <InputOTPSlotFace key={index} />
      ),
    )}
  </InputOTPGroup>
);

export const AuthCodeVerification = ({
  input,
  verify,
}: {
  input: ReactNode;
  verify: ReactNode;
}) => (
  <div className="mx-auto flex w-fit flex-col items-stretch gap-2">
    {input}
    {verify}
  </div>
);

export const AuthCodeVerificationPending = () => (
  <AuthCodeVerification
    input={<AuthCodeSlots />}
    verify={
      <ButtonFace size="default" variant="default">
        <PendingText barClassName="w-9" id="common.verify" />
      </ButtonFace>
    }
  />
);

export const AuthCodeActionRow = ({ children }: PropsWithChildren) => (
  <div className="mt-3 flex justify-center">{children}</div>
);
