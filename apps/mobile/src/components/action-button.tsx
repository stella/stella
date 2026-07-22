import { ActivityIndicator, Pressable, StyleSheet, Text } from "react-native";

import { useAppColors } from "@/theme";

type ActionButtonProps = {
  disabled?: boolean;
  label: string;
  loading?: boolean;
  onPress: () => void;
  variant?: "primary" | "secondary" | "danger";
};

export const ActionButton = ({
  disabled = false,
  label,
  loading = false,
  onPress,
  variant = "primary",
}: ActionButtonProps) => {
  const colors = useAppColors();
  const isDisabled = disabled || loading;
  let backgroundColor: string = colors.card;
  if (variant === "primary") {
    backgroundColor = colors.accent;
  } else if (variant === "danger") {
    backgroundColor = colors.danger;
  }
  const foregroundColor =
    variant === "secondary" ? colors.text : colors.background;
  const opacity = (pressed: boolean) => {
    if (isDisabled) {
      return 0.5;
    }
    return pressed ? 0.78 : 1;
  };

  return (
    <Pressable
      accessibilityRole="button"
      disabled={isDisabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor,
          borderColor:
            variant === "secondary" ? colors.border : backgroundColor,
          opacity: opacity(pressed),
        },
      ]}
    >
      {loading ? (
        <ActivityIndicator color={foregroundColor} />
      ) : (
        <Text style={[styles.label, { color: foregroundColor }]}>{label}</Text>
      )}
    </Pressable>
  );
};

const styles = StyleSheet.create({
  button: {
    alignItems: "center",
    borderCurve: "continuous",
    borderRadius: 14,
    borderWidth: 1,
    justifyContent: "center",
    minHeight: 50,
    paddingHorizontal: 18,
  },
  label: {
    fontSize: 16,
    fontWeight: "600",
  },
});
