import type { ReactNode } from "react";

import { ScrollView, StyleSheet, Text, View } from "react-native";

import { useAppColors } from "@/theme";

type EmptyStateScreenProps = {
  children?: ReactNode;
  description: string;
  emptyDescription: string;
  emptyTitle: string;
};

export const EmptyStateScreen = ({
  children,
  description,
  emptyDescription,
  emptyTitle,
}: EmptyStateScreenProps) => {
  const colors = useAppColors();

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
      style={[styles.screen, { backgroundColor: colors.background }]}
    >
      <Text style={[styles.description, { color: colors.muted }]}>
        {description}
      </Text>

      {children}

      <View
        style={[
          styles.emptyState,
          { backgroundColor: colors.card, borderColor: colors.border },
        ]}
      >
        <Text style={[styles.emptyTitle, { color: colors.text }]}>
          {emptyTitle}
        </Text>
        <Text style={[styles.emptyDescription, { color: colors.muted }]}>
          {emptyDescription}
        </Text>
      </View>
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  content: {
    flexGrow: 1,
    gap: 24,
    padding: 20,
    paddingTop: 28,
  },
  description: {
    fontSize: 16,
    lineHeight: 23,
  },
  emptyDescription: {
    fontSize: 15,
    lineHeight: 22,
    maxWidth: 360,
    textAlign: "center",
  },
  emptyState: {
    alignItems: "center",
    borderCurve: "continuous",
    borderRadius: 20,
    borderWidth: 1,
    flex: 1,
    justifyContent: "center",
    minHeight: 260,
    padding: 32,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: "600",
    marginBottom: 8,
  },
  screen: {
    flex: 1,
  },
});
