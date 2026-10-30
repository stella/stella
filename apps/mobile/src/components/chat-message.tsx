import { View } from "react-native";
import { useTranslations } from "use-intl";

import { Text } from "@stll/ui/text";

import { ChatAttachmentChip } from "@/components/chat-attachment-chip";
import { MarkdownView } from "@/components/markdown-view";
import type { ChatEntry } from "@/state/chat-messages";

/**
 * One message. What the person wrote sits in a quiet bubble on the right,
 * under the files they attached; the assistant's answer runs the full width
 * as a document, with the tools it used on the way as quiet one-line notes
 * above it. `uploading` marks the files of a message still going up.
 */
export const ChatMessage = ({
  entry,
  uploading = false,
}: {
  entry: ChatEntry;
  uploading?: boolean;
}) => {
  const t = useTranslations("chat");

  if (entry.role === "user") {
    return (
      <View className="items-end gap-1.5">
        {entry.files.map((file, index) => (
          <ChatAttachmentChip
            status={uploading ? "busy" : "idle"}
            // oxlint-disable-next-line react/no-array-index-key -- two files may share a name; a message's files never reorder.
            key={`${index}:${file.name}`}
            mimeType={file.mimeType}
            name={file.name}
          />
        ))}
        {entry.text === "" ? null : (
          <View className="bg-secondary max-w-[85%] rounded-2xl rounded-br-md px-3.5 py-2.5">
            <Text selectable>{entry.text}</Text>
          </View>
        )}
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
