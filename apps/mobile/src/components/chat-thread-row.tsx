import { Link } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useFormatter, useTranslations } from "use-intl";

import type {
  ChatThreadSection,
  ChatThreadSummary,
} from "@/state/chat-threads";
import { useAppColors } from "@/theme";

/**
 * One thread: its title, then the matter it belongs to. Today's and
 * yesterday's threads show the time, older ones the date, since the section
 * heading already says which day.
 */
export const ChatThreadRow = ({
  section,
  thread,
}: {
  section: ChatThreadSection["key"];
  thread: ChatThreadSummary;
}) => {
  const colors = useAppColors();
  const format = useFormatter();
  const t = useTranslations("chat");
  const updatedAt = new Date(thread.updatedAt);
  const when =
    section === "today" || section === "yesterday"
      ? format.dateTime(updatedAt, { hour: "numeric", minute: "2-digit" })
      : format.dateTime(updatedAt, { day: "numeric", month: "short" });
  const title = thread.title.trim() === "" ? t("untitled") : thread.title;

  return (
    <Link
      asChild
      href={{
        pathname: "/thread/[threadId]",
        params: { threadId: thread.id, title },
      }}
    >
      <Pressable
        accessibilityRole="button"
        style={({ pressed }) => [
          styles.row,
          {
            backgroundColor: pressed ? colors.background : colors.card,
            borderColor: colors.border,
          },
        ]}
      >
        <View style={styles.titleLine}>
          <Text
            numberOfLines={2}
            style={[styles.title, { color: colors.text }]}
          >
            {title}
          </Text>
          <Text style={[styles.when, { color: colors.muted }]}>{when}</Text>
        </View>
        {thread.matterName === undefined ? null : (
          <Text
            numberOfLines={1}
            style={[styles.matter, { color: colors.muted }]}
          >
            {thread.matterName}
          </Text>
        )}
      </Pressable>
    </Link>
  );
};

const styles = StyleSheet.create({
  matter: {
    fontSize: 14,
  },
  row: {
    borderRadius: 16,
    borderWidth: 1,
    gap: 4,
    marginBottom: 10,
    padding: 16,
  },
  title: {
    flex: 1,
    fontSize: 17,
    fontWeight: "600",
  },
  titleLine: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: 12,
  },
  when: {
    fontSize: 14,
    paddingTop: 2,
  },
});
