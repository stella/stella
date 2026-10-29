import { Pressable } from "react-native";

import { Text } from "@/components/ui/text";

export const ActionButton = ({
  label,
  onPress,
  disabled = false,
  selected = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  selected?: boolean;
}) => (
  <Pressable
    accessibilityRole="button"
    accessibilityState={{ disabled, selected }}
    disabled={disabled}
    onPress={onPress}
    className={`min-h-11 min-w-11 items-center justify-center rounded-xl px-4 py-3 active:opacity-60 ${selected ? "bg-accent" : "bg-secondary"}`}
    style={{ opacity: disabled ? 0.5 : 1 }}
  >
    <Text variant="button">{label}</Text>
  </Pressable>
);
