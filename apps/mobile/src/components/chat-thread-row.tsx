import { Link } from "expo-router";
import { Pressable, View } from "react-native";
import { useFormatter, useTranslations } from "use-intl";

import { MatterIcon } from "@/components/ui/matter-icon";
import { Text } from "@/components/ui/text";
import type {
  ChatThreadSection,
  ChatThreadSummary,
} from "@/state/chat-threads";

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
        params: {
          threadId: thread.id,
          title,
          ...(thread.matterId === undefined
            ? {}
            : { matterId: thread.matterId }),
        },
      }}
    >
      <Pressable
        accessibilityRole="button"
        className="border-border active:bg-accent gap-0.5 border-b py-3"
      >
        <View className="flex-row items-start gap-3">
          <View className="flex-1">
            <Text numberOfLines={2} variant="rowTitle">
              {title}
            </Text>
          </View>
          <Text variant="caption">{when}</Text>
        </View>
        {thread.matterName === undefined ||
        thread.matterId === undefined ? null : (
          <View className="flex-row items-center gap-1.5">
            <MatterIcon matter={{ id: thread.matterId }} size={12} />
            <View className="flex-1">
              <Text numberOfLines={1} variant="caption">
                {thread.matterName}
              </Text>
            </View>
          </View>
        )}
      </Pressable>
    </Link>
  );
};
