import { View } from "react-native";
import { useTranslations } from "use-intl";

import { MarkdownView } from "@/components/markdown-view";
import { Text } from "@/components/ui/text";
import type { ChatEntry } from "@/state/chat-messages";

/**
 * One message. What the person wrote sits in a quiet bubble on the right; the
 * assistant's answer runs the full width as a document, with the tools it
 * used on the way as quiet one-line notes above it.
 */
export const ChatMessage = ({ entry }: { entry: ChatEntry }) => {
  const t = useTranslations("chat");

  if (entry.role === "user") {
    return (
      <View className="items-end">
        <View className="bg-secondary max-w-[85%] rounded-2xl rounded-br-md px-3.5 py-2.5">
          <Text selectable>{entry.text}</Text>
        </View>
      </View>
    );
  }

  return (
    <View className="gap-1.5 py-1">
      {entry.tools.map((tool, index) => (
        <Text
          // oxlint-disable-next-line react/no-array-index-key -- the same tool can run twice in one answer.
          key={`${index}:${tool}`}
          numberOfLines={1}
          variant="caption"
        >
          {t("toolUsed", { tool: tool.replaceAll("_", " ") })}
        </Text>
      ))}
      {entry.text === "" ? null : <MarkdownView markdown={entry.text} />}
    </View>
  );
};
