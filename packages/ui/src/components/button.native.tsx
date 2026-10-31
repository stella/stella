import type { PressableProps } from "react-native";
import { Pressable } from "react-native";

import { cn } from "../lib/utils";
import {
  BUTTON_VARIANT_TOKENS,
  type ButtonContract,
  type ButtonSize,
  type ButtonVariant,
} from "./button.shared";
import { Loader } from "./loader.native";
import { Text } from "./text.native";

/** A control's box: centred content inside the variant's border. */
const CONTROL = "items-center justify-center border";

/**
 * Every shared size in a phone's metrics. A text size grows to the platform's
 * 44-point touch target where the web relies on a coarse-pointer hit area; a
 * smaller control keeps its look and reaches the target through `slop`.
 */
const SIZES = {
  chip: {
    box: `${CONTROL} min-h-7 gap-1.5 rounded-full px-2.5`,
    label: "text-xs",
    slop: 8,
  },
  default: {
    box: `${CONTROL} min-h-11 gap-2 rounded-lg px-4`,
    label: "",
    slop: 0,
  },
  icon: { box: `${CONTROL} size-11 rounded-lg`, label: "", slop: 0 },
  "icon-lg": { box: `${CONTROL} size-12 rounded-lg`, label: "", slop: 0 },
  "icon-sm": { box: `${CONTROL} size-8 rounded-lg`, label: "", slop: 6 },
  "icon-xl": { box: `${CONTROL} size-11 rounded-lg`, label: "", slop: 0 },
  "icon-xs": { box: `${CONTROL} size-7 rounded-md`, label: "", slop: 8 },
  lg: { box: `${CONTROL} min-h-12 gap-2 rounded-lg px-5`, label: "", slop: 0 },
  // One row of a list: a full-width target at least a touch target tall,
  // laid out by the content it holds (a glyph beside two lines of text, a
  // chevron trailing). The list draws the dividers between rows.
  row: { box: "min-h-11 w-full rounded-lg", label: "", slop: 0 },
  sm: {
    box: `${CONTROL} min-h-9 gap-1.5 rounded-lg px-3`,
    label: "text-sm",
    slop: 0,
  },
  xl: {
    box: `${CONTROL} min-h-14 gap-2 rounded-lg px-6`,
    label: "text-lg",
    slop: 0,
  },
  xs: {
    box: `${CONTROL} min-h-7 gap-1 rounded-md px-2`,
    label: "text-sm",
    slop: 8,
  },
} as const satisfies Record<
  ButtonSize,
  { box: string; label: string; slop: number }
>;

/**
 * A phone has no hover: a pressed button answers with the fill the web shows
 * on hover, or dims when it already has one. `selected` is the pressed state
 * held (a row open beside the list, a chosen option).
 */
const PRESS = {
  default: { pressed: "active:opacity-80", selected: "" },
  destructive: { pressed: "active:bg-destructive/18", selected: "" },
  "destructive-outline": { pressed: "active:bg-destructive/4", selected: "" },
  "destructive-ghost": {
    pressed: "active:bg-destructive/10",
    selected: "bg-destructive/10",
  },
  ghost: { pressed: "active:bg-accent", selected: "bg-accent" },
  link: { pressed: "active:opacity-60", selected: "" },
  muted: { pressed: "active:bg-accent", selected: "bg-accent" },
  outline: { pressed: "active:bg-accent", selected: "bg-accent" },
  secondary: { pressed: "active:bg-secondary/80", selected: "" },
} as const satisfies Record<
  ButtonVariant,
  { pressed: string; selected: string }
>;

type ButtonProps = Omit<PressableProps, "children" | "disabled"> &
  ButtonContract & { className?: string | undefined };

/**
 * The web's `Button` (./button.tsx) on a phone: the same variants and sizes,
 * read from ./button.shared.ts, on a Pressable. A string child is set as the
 * button's label in its variant's colour; any other child is laid out as
 * given, which is how a row holds a glyph beside two lines of text.
 */
export const Button = ({
  accessibilityState,
  children,
  className,
  disabled = false,
  hitSlop,
  icon,
  loading = false,
  size,
  variant,
  ...props
}: ButtonProps) => {
  const shape = SIZES[size ?? "default"];
  const tokens = BUTTON_VARIANT_TOKENS[variant ?? "default"];
  const press = PRESS[variant ?? "default"];
  const inactive = disabled || loading;
  const selected = accessibilityState?.selected === true;
  const label = cn(
    tokens.label,
    variant === "link" && "text-foreground underline",
    shape.label,
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{
        ...accessibilityState,
        busy: loading,
        disabled: inactive,
      }}
      // As on the web, a caller's class wins over the button's own.
      className={cn(
        "flex-row",
        tokens.surface,
        shape.box,
        inactive ? "opacity-64" : press.pressed,
        selected && press.selected,
        className,
      )}
      disabled={inactive}
      hitSlop={hitSlop ?? (shape.slop === 0 ? undefined : shape.slop)}
      {...props}
    >
      {loading ? <Loader size="sm" variant="decorative" /> : icon}
      {typeof children === "string" || typeof children === "number" ? (
        <Text className={label} variant="button">
          {children}
        </Text>
      ) : (
        children
      )}
    </Pressable>
  );
};
