import { StyleSheet, Text } from "react-native";

import { useAppColors } from "@/theme";

export const InlineMessage = ({ message }: { message: string }) => {
  const colors = useAppColors();
  return (
    <Text selectable style={[styles.message, { color: colors.danger }]}>
      {message}
    </Text>
  );
};

const styles = StyleSheet.create({
  message: {
    fontSize: 14,
    lineHeight: 20,
  },
});
