import { use } from "react";

import { Pressable, Share, View } from "react-native";
import { useTranslations } from "use-intl";

import { MOBILE_REDIRECT_SCHEMES } from "@stll/api-contract/mobile-client";
import { Text } from "@stll/ui/text";

import { AnswerSteps } from "@/components/answer-steps";
import { ChatAttachmentChip } from "@/components/chat-attachment-chip";
import { MarkdownView } from "@/components/markdown-view";
import { ThreadMatter } from "@/components/thread-matter";
import { APP_VARIANT } from "@/env";
import type { SentFile } from "@/state/chat-attachments";
import type { ChatEntry } from "@/state/chat-messages";
import { plainText } from "@/state/markdown";

/**
 * One message. What the person wrote sits in a quiet bubble on the right,
 * under the files they attached, drawn from its markdown so a mention reads
 * as the chip of what it names; the assistant's answer runs the full width
 * as a document, its texts in order with a summary of each run of steps the
 * model took between them. `uploading` marks the files of a message still
 * going up; `live` an answer still arriving, whose last run says the step it
 * is on.
 */
export const ChatMessage = ({
  entry,
  live = false,
  uploading = false,
}: {
  entry: ChatEntry;
  live?: boolean;
  uploading?: boolean;
}) => {
  if (entry.role === "user") {
    return (
      <View className="items-end gap-1.5">
        {keyedFiles(entry.files).map(({ file, key }) => (
          <ChatAttachmentChip
            status={uploading ? "busy" : "idle"}
            key={key}
            mimeType={file.mimeType}
            name={file.name}
          />
        ))}
        {entry.text === "" ? null : (
          <View className="bg-secondary max-w-[85%] rounded-2xl rounded-br-md px-3.5 py-2.5">
            <MarkdownView markdown={entry.text} variant="message" />
          </View>
        )}
      </View>
    );
  }

  const last = entry.blocks.at(-1);
  return (
    <View className="gap-2.5 py-1">
      {entry.blocks.map((block) =>
        block.type === "text" ? (
          <MarkdownView key={`text:${block.key}`} markdown={block.markdown} />
        ) : (
          <AnswerSteps
            block={block}
            key={`steps:${block.key}`}
            live={live && block === last}
          />
        ),
      )}
      {live || entry.text === "" ? null : <ShareAnswer text={entry.text} />}
    </View>
  );
};

/**
 * Hands a finished answer to the system's share sheet, which copies it too,
 * as the text a person reads: each mention as its name, no markdown.
 */
const ShareAnswer = ({ text }: { text: string }) => {
  const t = useTranslations("link");
  const matterId = use(ThreadMatter);
  return (
    <Pressable
      accessibilityRole="button"
      className="self-start"
      hitSlop={8}
      onPress={() => {
        const message = plainText(text, {
          appScheme: MOBILE_REDIRECT_SCHEMES[APP_VARIANT],
          matterId,
        });
        void Share.share({ message });
      }}
    >
      <Text variant="caption">{t("share")}</Text>
    </Pressable>
  );
};

/** Each file with a key that tells apart two files of the same name. */
function keyedFiles(files: readonly SentFile[]) {
  const seen = new Map<string, number>();
  return files.map((file) => {
    const earlier = seen.get(file.name) ?? 0;
    seen.set(file.name, earlier + 1);
    return { file, key: `${file.name}#${String(earlier)}` };
  });
}
