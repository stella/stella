import { Pressable } from "react-native";

import { Text } from "@stll/ui/text";

import { useUiColors } from "@/theme";

/** One of a row of choices, filled while it is the chosen one. */
export const ChoiceChip = ({
  disabled = false,
  label,
  onPress,
  selected,
}: {
  disabled?: boolean;
  label: string;
  onPress: () => void;
  selected: boolean;
}) => {
  const ui = useUiColors();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ disabled, selected }}
      className={`rounded-full border px-3 py-1.5 active:opacity-60 ${
        selected ? "border-foreground bg-foreground" : "border-border bg-card"
      } ${disabled && !selected ? "opacity-50" : ""}`}
      disabled={disabled}
      onPress={onPress}
    >
      <Text
        style={selected ? { color: ui.background } : undefined}
        variant="label"
      >
        {label}
      </Text>
    </Pressable>
  );
};
