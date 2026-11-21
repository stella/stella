import { cn } from "../lib/utils";

const InputOTPGroup = ({
  className,
  ...props
}: React.ComponentProps<"div">) => (
  <div
    className={cn("flex items-center", className)}
    data-slot="input-otp-group"
    {...props}
  />
);

/** The box behind each code character, including before the input mounts. */
const InputOTPSlotFace = ({
  className,
  ...props
}: React.ComponentProps<"div">) => (
  <div
    className={cn(
      "border-input aria-invalid:border-destructive data-[active=true]:border-ring data-[active=true]:ring-ring/50 data-[active=true]:aria-invalid:border-destructive data-[active=true]:aria-invalid:ring-destructive/20 dark:bg-input/30 dark:data-[active=true]:aria-invalid:ring-destructive/40 relative flex h-9 w-9 items-center justify-center border-y border-e text-sm shadow-xs outline-none first:rounded-s-md first:border-s last:rounded-e-md data-[active=true]:z-10 data-[active=true]:ring-[3px]",
      className,
    )}
    data-slot="input-otp-slot"
    {...props}
  />
);

export { InputOTPGroup, InputOTPSlotFace };
