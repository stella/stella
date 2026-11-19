"use client";

import * as React from "react";

import { OTPInput, OTPInputContext } from "input-otp";

import { MinusIcon } from "../icons";
import { cn } from "../lib/utils";
import { InputOTPSlotFace } from "./input-otp-face";

export { InputOTPGroup } from "./input-otp-face";

const InputOTP = ({
  className,
  containerClassName,
  ...props
}: React.ComponentProps<typeof OTPInput> & {
  containerClassName?: string;
}) => (
  <OTPInput
    className={cn("disabled:cursor-not-allowed", className)}
    containerClassName={cn(
      "flex items-center gap-2 has-disabled:opacity-50",
      containerClassName,
    )}
    data-slot="input-otp"
    {...props}
  />
);

const InputOTPSlot = ({
  index,
  className,
  ...props
}: React.ComponentProps<"div"> & {
  index: number;
}) => {
  const inputOTPContext = React.use(OTPInputContext);
  const { char, hasFakeCaret, isActive } = inputOTPContext.slots[index] ?? {};

  return (
    <InputOTPSlotFace className={className} data-active={isActive} {...props}>
      {char}
      {hasFakeCaret && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="animate-caret-blink bg-foreground h-4 w-px" />
        </div>
      )}
    </InputOTPSlotFace>
  );
};

const InputOTPSeparator = ({ ...props }: React.ComponentProps<"div">) => (
  <div data-slot="input-otp-separator" role="separator" {...props}>
    <MinusIcon />
  </div>
);

export { InputOTP, InputOTPSlot, InputOTPSeparator };
