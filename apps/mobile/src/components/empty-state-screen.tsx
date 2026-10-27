import type { ReactNode } from "react";

import { ScrollView, StyleSheet, View } from "react-native";

import { Text } from "@/components/ui/text";

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
}: EmptyStateScreenProps) => (
  <View className="bg-background flex-1">
    <ScrollView
      className="flex-1"
      contentContainerStyle={screenStyles.content}
      contentInsetAdjustmentBehavior="automatic"
    >
      <ScreenHeading description={description} title={title} />
      {children}
      <EmptyCard description={emptyDescription} title={emptyTitle} />
    </ScrollView>
  </View>
);

/** A screen's large title, as iOS sets one, with an optional line under it. */
export const ScreenHeading = ({
  description,
  title,
}: {
  description?: string | undefined;
  title: string;
}) => (
  <View className="gap-1">
    <Text accessibilityRole="header" variant="largeTitle">
      {title}
    </Text>
    {description === undefined ? null : (
      <Text variant="caption">{description}</Text>
    )}
  </View>
);

/** What a list shows when it has nothing, centred in a quiet card. */
export const EmptyCard = ({
  children,
  description,
  title,
}: React.PropsWithChildren<{ description: string; title: string }>) => (
  <View className="border-border bg-card min-h-64 flex-1 items-center justify-center gap-2 rounded-xl border p-8">
    <Text variant="headline">{title}</Text>
    <Text className="max-w-90 text-center" variant="caption">
      {description}
    </Text>
    {children}
  </View>
);

export const screenStyles = StyleSheet.create({
  content: {
    flexGrow: 1,
    gap: 20,
    padding: 16,
    paddingTop: 24,
  },
  screen: {
    flex: 1,
  },
});
