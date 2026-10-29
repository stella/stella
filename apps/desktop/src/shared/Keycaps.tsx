import { cn } from "@stll/ui/utils";

type KeycapState = "idle" | "down" | "done" | "wrong";

export type Keycap = {
  /** Stable within one row: the modifier name, `key`, or `extra`. */
  id: string;
  label: string;
  state?: KeycapState;
};

type KeycapsProps = {
  caps: readonly Keycap[];
  size?: "sm" | "lg";
  className?: string;
};

const STATE_CLASSES = {
  done: "border-success bg-success/12 text-success-foreground",
  down: "border-foreground bg-foreground text-background translate-y-px border-b",
  idle: "bg-background text-foreground border-b-2",
  wrong:
    "border-destructive text-destructive-foreground bg-transparent border-b",
} as const satisfies Record<KeycapState, string>;

const SIZE_CLASSES = {
  lg: "min-w-12 h-12 px-3 text-lg rounded-xl",
  sm: "min-w-6 h-6 px-1.5 text-xs rounded-md",
} as const satisfies Record<NonNullable<KeycapsProps["size"]>, string>;

/** Keyboard keys as keycaps, in reading order. Keys keep source order in
 *  right-to-left layouts: a shortcut is pressed, not read. */
export const Keycaps = ({ caps, className, size = "sm" }: KeycapsProps) => (
  <span className={cn("inline-flex gap-1", className)} dir="ltr">
    {caps.map((cap) => (
      <kbd
        className={cn(
          "inline-grid place-items-center border font-sans font-semibold tabular-nums",
          SIZE_CLASSES[size],
          STATE_CLASSES[cap.state ?? "idle"],
        )}
        key={cap.id}
      >
        {cap.label}
      </kbd>
    ))}
  </span>
);
