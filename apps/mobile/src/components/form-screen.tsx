import type { ReactNode } from "react";

import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useAppColors } from "@/theme";

type FormScreenProps = {
  children: ReactNode;
  description: string;
};

export const FormScreen = ({ children, description }: FormScreenProps) => {
  const colors = useAppColors();
  const insets = useSafeAreaInsets();

  return (
    <ScrollView
      automaticallyAdjustKeyboardInsets
      contentContainerStyle={[
        styles.content,
        {
          paddingBottom: Math.max(20, insets.bottom + 20),
          paddingTop: Math.max(20, insets.top + 20),
        },
      ]}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      style={{ backgroundColor: colors.background }}
    >
      <View style={styles.frame}>
        <Text selectable style={[styles.description, { color: colors.muted }]}>
          {description}
        </Text>
        {children}
      </View>
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  content: {
    alignItems: "center",
    flexGrow: 1,
    justifyContent: "center",
    padding: 20,
  },
  description: {
    fontSize: 16,
    lineHeight: 23,
  },
  frame: {
    gap: 20,
    maxWidth: 440,
    paddingVertical: 32,
    width: "100%",
  },
});
