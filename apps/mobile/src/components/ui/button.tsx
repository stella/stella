import { ActivityIndicator, Pressable, View } from "react-native";
import type { PressableProps } from "react-native";

import { BUTTON_VARIANTS } from "@/components/ui/button-variants";
import type { ButtonVariant } from "@/components/ui/button-variants";
import { Text } from "@/components/ui/text";
import { useAppColors } from "@/theme";

/** Touch sizes: a phone's controls stay at least 44 points tall. */
const BUTTON_SIZES = {
  default: "min-h-11 px-4",
  lg: "min-h-12 px-5",
  sm: "min-h-9 px-3",
} as const;

export const Button = ({
  className,
  label,
  loading = false,
  size = "default",
  variant = "default",
  ...props
}: Omit<PressableProps, "children"> & {
  className?: string;
  label: string;
  loading?: boolean;
  size?: keyof typeof BUTTON_SIZES;
  variant?: ButtonVariant;
}) => {
  const colors = useAppColors();
  const { box, label: labelClass } = BUTTON_VARIANTS[variant];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ busy: loading, disabled: props.disabled === true }}
      className={`flex-row items-center justify-center rounded-lg border active:opacity-80 disabled:opacity-64 ${box} ${BUTTON_SIZES[size]} ${className ?? ""}`}
      {...props}
    >
      <View className="flex-row items-center gap-2">
        {loading ? (
          <ActivityIndicator
            color={variant === "default" ? colors.onAccent : colors.text}
          />
        ) : null}
        <Text className={labelClass} variant="button">
          {label}
        </Text>
      </View>
    </Pressable>
  );
};
