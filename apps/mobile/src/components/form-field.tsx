import type { TextInputProps } from "react-native";
import { StyleSheet, Text, TextInput, View } from "react-native";

import { useAppColors } from "@/theme";

type FormFieldProps = TextInputProps & {
  error?: string | null;
  label: string;
};

export const FormField = ({
  error,
  label,
  style,
  ...props
}: FormFieldProps) => {
  const colors = useAppColors();

  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: colors.text }]}>{label}</Text>
      <TextInput
        {...props}
        accessibilityLabel={props.accessibilityLabel ?? label}
        placeholderTextColor={colors.muted}
        style={[
          styles.input,
          {
            backgroundColor: colors.card,
            borderColor: error ? colors.danger : colors.border,
            color: colors.text,
          },
          style,
        ]}
      />
      {error ? (
        <Text selectable style={[styles.error, { color: colors.danger }]}>
          {error}
        </Text>
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  error: {
    fontSize: 13,
    lineHeight: 18,
  },
  field: {
    gap: 7,
  },
  input: {
    borderCurve: "continuous",
    borderRadius: 14,
    borderWidth: 1,
    fontSize: 16,
    minHeight: 50,
    paddingHorizontal: 15,
    paddingVertical: 12,
  },
  label: {
    fontSize: 14,
    fontWeight: "600",
  },
});
