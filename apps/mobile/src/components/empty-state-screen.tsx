import type { ReactNode } from "react";

import { ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useAppColors } from "@/theme";

type EmptyStateScreenProps = {
  children?: ReactNode;
  description: string;
  emptyDescription: string;
  emptyTitle: string;
  title: string;
};

export const EmptyStateScreen = ({
  children,
  description,
  emptyDescription,
  emptyTitle,
  title,
}: EmptyStateScreenProps) => {
  const colors = useAppColors();

  return (
    <SafeAreaView
      edges={["top"]}
      style={[styles.screen, { backgroundColor: colors.background }]}
    >
      <ScrollView contentContainerStyle={styles.content} style={styles.screen}>
        <ScreenHeading description={description} title={title} />
        {children}
        <EmptyCard description={emptyDescription} title={emptyTitle} />
      </ScrollView>
    </SafeAreaView>
  );
};

export const ScreenHeading = ({
  description,
  title,
}: {
  description?: string | undefined;
  title: string;
}) => {
  const colors = useAppColors();

  return (
    <View style={styles.heading}>
      <Text
        accessibilityRole="header"
        style={[styles.title, { color: colors.text }]}
      >
        {title}
      </Text>
      {description === undefined ? null : (
        <Text style={[styles.description, { color: colors.muted }]}>
          {description}
        </Text>
      )}
    </View>
  );
};

export const EmptyCard = ({
  children,
  description,
  title,
}: React.PropsWithChildren<{ description: string; title: string }>) => {
  const colors = useAppColors();

  return (
    <View
      style={[
        styles.emptyState,
        { backgroundColor: colors.card, borderColor: colors.border },
      ]}
    >
      <Text style={[styles.emptyTitle, { color: colors.text }]}>{title}</Text>
      <Text style={[styles.emptyDescription, { color: colors.muted }]}>
        {description}
      </Text>
      {children}
    </View>
  );
};

export const screenStyles = StyleSheet.create({
  content: {
    flexGrow: 1,
    gap: 24,
    padding: 20,
    paddingTop: 28,
  },
  screen: {
    flex: 1,
  },
});

const styles = StyleSheet.create({
  ...screenStyles,
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
    borderRadius: 20,
    borderWidth: 1,
    flex: 1,
    gap: 8,
    justifyContent: "center",
    minHeight: 260,
    padding: 32,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: "600",
  },
  heading: {
    gap: 8,
  },
  title: {
    fontSize: 34,
    fontWeight: "700",
    letterSpacing: -1,
  },
});
