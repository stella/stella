import type { TextInputProps } from "react-native";
import { TextInput } from "react-native";

import type { ControlSize } from "../lib/control-size";
import { cn } from "../lib/utils";
import type { InputContract, TextFieldContract } from "./input.shared";
import { textFontFamily } from "./text.native";

/** The field's text at each control size, as the web sets it on a phone. */
const TEXT_SIZE = {
  sm: "text-sm",
  default: "text-base",
  lg: "text-base",
} as const satisfies Record<ControlSize, string>;

/** The web input's box (hairline border, card fill) at each control size. */
const BOX = {
  sm: "min-h-9 rounded-lg border border-input bg-card px-3",
  default: "min-h-11 rounded-lg border border-input bg-card px-3",
  lg: "min-h-12 rounded-lg border border-input bg-card px-3",
} as const satisfies Record<ControlSize, string>;

/** A search field, filled and borderless, as iOS sets one over a list. */
const SEARCH_BOX = "min-h-10 rounded-xl bg-secondary px-3";

type NativeFieldProps = Omit<TextInputProps, keyof TextFieldContract> &
  TextFieldContract & { className?: string | undefined };

/**
 * A text field in the web's type and colours: the caret, placeholder and
 * selection read the theme tokens, and `disabled` stops editing.
 */
export const NativeField = ({
  box,
  className,
  disabled = false,
  editable = true,
  onChangeText,
  onValueChange,
  size = "default",
  style,
  ...props
}: NativeFieldProps & { box: string }) => (
  <TextInput
    cursorColorClassName="accent-foreground"
    placeholderTextColorClassName="accent-muted-foreground"
    selectionColorClassName="accent-ring"
    {...props}
    className={cn(
      "text-foreground",
      box,
      TEXT_SIZE[size],
      disabled && "opacity-64",
      className,
    )}
    editable={editable && !disabled}
    onChangeText={(text) => {
      onChangeText?.(text);
      onValueChange?.(text);
    }}
    style={[{ fontFamily: textFontFamily("body") }, style]}
  />
);

type InputProps = NativeFieldProps & {
  type?: InputContract["type"];
};

/** What each field type asks the platform's keyboard for. */
const INPUT_MODE = {
  email: "email",
  search: "search",
  tel: "tel",
  text: "text",
  url: "url",
} as const satisfies Record<
  NonNullable<InputContract["type"]>,
  TextInputProps["inputMode"]
>;

/** The field's own box: none, iOS's search field, or the web's box. */
const inputBox = (
  type: NonNullable<InputContract["type"]>,
  size: ControlSize,
  unstyled: boolean,
): string => {
  if (unstyled) {
    return "min-h-9 py-2";
  }
  return type === "search" ? SEARCH_BOX : BOX[size];
};

/**
 * The web's `Input` (./input.tsx) on a phone: one line of text, in the web's
 * box, or iOS's filled search field for `type="search"`.
 */
export const Input = ({
  type = "text",
  unstyled = false,
  size = "default",
  ...props
}: InputProps) => (
  <NativeField
    inputMode={INPUT_MODE[type]}
    {...props}
    box={inputBox(type, size, unstyled)}
    size={size}
  />
);
