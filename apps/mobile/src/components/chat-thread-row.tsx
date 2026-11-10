import { useRouter } from "expo-router";
import { Pressable, View } from "react-native";
import { useFormatter, useTranslations } from "use-intl";

import type { ChatActiveRunState } from "@stll/api-contract/chat";
import { MatterIcon } from "@stll/ui/matter-icon";
import { RunStateMark } from "@stll/ui/run-state-mark";
import { Text } from "@stll/ui/text";

import { useLayout, useSelection } from "@/components/selection";
import type {
  ChatThreadSection,
  ChatThreadSummary,
} from "@/state/chat-threads";

/**
 * One thread: its title, then the matter it belongs to. Today's and
 * yesterday's threads show the time, older ones the date. A thread with an
 * unfinished run shows its mark before the time; the section it heads names
 * the state. Tapping it opens the thread, beside the list where the window
 * has two columns, which marks it as the one open.
 */
export const ChatThreadRow = ({
  day,
  runState,
  thread,
}: {
  /** The day heading the thread's last activity falls under. */
  day: ChatThreadSection["key"];
  runState: ChatActiveRunState | undefined;
  thread: ChatThreadSummary;
}) => {
  const format = useFormatter();
  const t = useTranslations("chat");
  const updatedAt = new Date(thread.updatedAt);
  const when =
    day === "today" || day === "yesterday"
      ? format.dateTime(updatedAt, { hour: "numeric", minute: "2-digit" })
      : format.dateTime(updatedAt, { day: "numeric", month: "short" });
  const title = thread.title.trim() === "" ? t("untitled") : thread.title;
  const router = useRouter();
  const layout = useLayout();
  const selection = useSelection();
  const open = layout.usesSplitView && selection.thread?.threadId === thread.id;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: open }}
      className={`border-border active:bg-accent gap-0.5 border-b py-3 ${open ? "bg-accent" : ""}`}
      onPress={() => {
        if (layout.usesSplitView) {
          selection.select("thread", {
            matterId: thread.matterId,
            threadId: thread.id,
            title,
          });
          return;
        }
        router.push({
          pathname: "/thread/[threadId]",
          params: {
            threadId: thread.id,
            title,
            ...(thread.matterId === undefined
              ? {}
              : { matterId: thread.matterId }),
          },
        });
      }}
    >
      <View className="flex-row items-start gap-3">
        <View className="flex-1">
          <Text numberOfLines={2} variant="rowTitle">
            {title}
          </Text>
        </View>
        <View className="flex-row items-center gap-1.5">
          {runState === undefined ? null : <RunStateMark state={runState} />}
          <Text variant="caption">{when}</Text>
        </View>
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
  );
};
