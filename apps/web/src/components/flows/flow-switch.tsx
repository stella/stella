import { cn } from "@stll/ui/lib/utils";

// A minimal accessible switch. @stll/ui has no toggle primitive yet, so this
// is a self-contained `role="switch"` button using semantic tokens. Keep it
// local to the Workflows slice rather than hand-rolling raw markup at call
// sites.

type FlowSwitchProps = {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  "aria-label": string;
  className?: string;
};

export const FlowSwitch = ({
  checked,
  onCheckedChange,
  disabled,
  className,
  ...props
}: FlowSwitchProps) => (
  <button
    aria-checked={checked}
    aria-label={props["aria-label"]}
    className={cn(
      "focus-visible:ring-ring inline-flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
      checked ? "bg-primary" : "bg-input",
      className,
    )}
    disabled={disabled}
    onClick={() => onCheckedChange(!checked)}
    role="switch"
    type="button"
  >
    <span
      className={cn(
        "bg-background size-4 rounded-full shadow-sm transition-transform",
        checked ? "translate-x-4" : "translate-x-0",
      )}
    />
  </button>
);
