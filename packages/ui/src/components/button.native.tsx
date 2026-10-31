import type { PressableProps } from "react-native";
import { Pressable } from "react-native";

import { nativeButtonClassNames } from "./button.native-classes";
import type { ButtonContract } from "./button.shared";
import { Loader } from "./loader.native";
import { Text } from "./text.native";

type ButtonProps = Omit<PressableProps, "children" | "disabled"> &
  ButtonContract & { className?: string | undefined };

/**
 * The web's `Button` (./button.tsx) on a phone: the same variants and sizes,
 * read from ./button.shared.ts, on a Pressable. A string child is set as the
 * button's label in its variant's colour; any other child is laid out as
 * given, which is how a row holds a glyph beside two lines of text. A
 * `plain` button paints no fill or label colour and ignores `size`: its
 * children are its look, stacked as in a View, inside a border that shows
 * only when it is selected. Its classes come from ./button.native-classes.ts.
 */
export const Button = ({
  accessibilityState,
  children,
  className,
  disabled = false,
  hitSlop,
  icon,
  loading = false,
  selected: selectedProp,
  size,
  variant: variantProp,
  ...props
}: ButtonProps) => {
  // An inline action with no variant reads as a link in its sentence, as on
  // the web.
  const variant = variantProp ?? (size === "inline" ? "link" : undefined);
  const inactive = disabled || loading;
  const look = nativeButtonClassNames({
    className,
    inactive,
    selected: selectedProp === true || accessibilityState?.selected === true,
    size,
    variant,
  });
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{
        ...accessibilityState,
        busy: loading,
        disabled: inactive,
      }}
      className={look.pressable}
      disabled={inactive}
      hitSlop={hitSlop ?? (look.slop === 0 ? undefined : look.slop)}
      {...props}
    >
      {loading ? <Loader size="sm" variant="decorative" /> : icon}
      {typeof children === "string" || typeof children === "number" ? (
        <Text className={look.label} variant="button">
          {children}
        </Text>
      ) : (
        children
      )}
    </Pressable>
  );
};
