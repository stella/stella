import { StyleSheet, Text, View } from "react-native";
import { useTranslations } from "use-intl";

import { MarkdownView } from "@/components/markdown-view";
import type { ChatEntry } from "@/state/chat-messages";
import { useAppColors } from "@/theme";

/**
 * One message. What the person wrote sits in a bubble on the right; the
 * assistant's answer runs the full width as a document, with the tools it
 * used on the way as quiet one-line notes above it.
 */
export const ChatMessage = ({ entry }: { entry: ChatEntry }) => {
  const colors = useAppColors();
  const t = useTranslations("chat");

  if (entry.role === "user") {
    return (
      <View style={styles.userRow}>
        <View style={[styles.bubble, { backgroundColor: colors.accent }]}>
          <Text
            selectable
            style={[styles.userText, { color: colors.onAccent }]}
          >
            {entry.text}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.answer}>
      {entry.tools.map((tool, index) => (
        <Text
          // oxlint-disable-next-line react/no-array-index-key -- the same tool can run twice in one answer.
          key={`${index}:${tool}`}
          numberOfLines={1}
          style={[styles.tool, { color: colors.muted }]}
        >
          {t("toolUsed", { tool: tool.replaceAll("_", " ") })}
        </Text>
      ))}
      {entry.text === "" ? null : <MarkdownView markdown={entry.text} />}
    </View>
  );
};

const styles = StyleSheet.create({
  answer: {
    gap: 6,
    paddingVertical: 4,
  },
  bubble: {
    borderRadius: 20,
    borderBottomRightRadius: 6,
    maxWidth: "85%",
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  tool: {
    fontSize: 13,
  },
  userRow: {
    alignItems: "flex-end",
  },
  userText: {
    fontSize: 16,
    lineHeight: 22,
  },
});
