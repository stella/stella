import { StyleSheet, View } from "react-native";

import { Text } from "@stll/ui/text";

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

/**
 * The widest a column of content grows, as t3code caps its chat: on an iPad
 * or a wide pane, lines and rows stay readable and the content centres.
 */
const READABLE_MAX_WIDTH = 960;

export const screenStyles = StyleSheet.create({
  content: {
    alignSelf: "center",
    flexGrow: 1,
    gap: 20,
    maxWidth: READABLE_MAX_WIDTH,
    padding: 16,
    paddingTop: 24,
    width: "100%",
  },
  /** A block, such as the message box, kept to the content's width. */
  readable: {
    alignSelf: "center",
    maxWidth: READABLE_MAX_WIDTH,
    width: "100%",
  },
  screen: {
    flex: 1,
  },
  /** Content as tall as it is, never stretched to the screen. */
  unstretched: {
    flexGrow: 0,
  },
});

/**
 * A list's content while it has no rows. Its card, stretched to the screen,
 * plus the translucent bar's inset overflowed the screen, so an empty list
 * scrolled; held to its own height, it does not. It still bounces, as the
 * pull that refreshes it needs.
 */
export const emptyListProps = (empty: boolean) => ({
  contentContainerStyle: empty
    ? [screenStyles.content, screenStyles.unstretched]
    : screenStyles.content,
});
