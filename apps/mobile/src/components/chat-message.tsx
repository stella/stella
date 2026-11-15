import { use } from "react";

import { panic } from "better-result";
import { Pressable, Share, View } from "react-native";
import { useTranslations } from "use-intl";

import type { AIErrorKind } from "@stll/api-contract/ai-errors";
import type { ChatContextNotice } from "@stll/api-contract/chat-context-notice";
import { MOBILE_REDIRECT_SCHEMES } from "@stll/api-contract/mobile-client";
import { Button } from "@stll/ui/button";
import { Text } from "@stll/ui/text";

import { AnswerSteps, AnswerSubagent } from "@/components/answer-steps";
import { ChatAttachmentChip } from "@/components/chat-attachment-chip";
import { MarkdownView } from "@/components/markdown-view";
import { ThreadMatter } from "@/components/thread-matter";
import { APP_VARIANT } from "@/env";
import type { SentFile } from "@/state/chat-attachments";
import { CHAT_FAILURE_KEYS } from "@/state/chat-failure";
import type { ChatEntry } from "@/state/chat-messages";
import { plainText } from "@/state/markdown";

/**
 * One message. What the person wrote sits in a quiet bubble on the right,
 * under the files they attached, drawn from its markdown so a mention reads
 * as the chip of what it names; the assistant's answer runs the full width
 * as a document, its texts in order with a summary of each run of steps the
 * model took between them, under what its context left out, if anything,
 * and why it failed when it did. `uploading` marks the files of a message
 * still going up; `live` an answer still arriving, whose last run says the
 * step it is on; `onRetry` answers the message a failed answer was for again.
 */
export const ChatMessage = ({
  entry,
  live = false,
  onRetry,
  uploading = false,
}: {
  entry: ChatEntry;
  live?: boolean;
  onRetry?: (() => void) | undefined;
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
      {entry.contextNotice === null ? null : (
        <ContextNotice notice={entry.contextNotice} />
      )}
      {entry.blocks.map((block) => {
        switch (block.type) {
          case "text":
            return (
              <MarkdownView
                key={`text:${block.key}`}
                markdown={block.markdown}
              />
            );
          case "steps":
            return (
              <AnswerSteps
                block={block}
                key={`steps:${block.key}`}
                live={live && block === last}
              />
            );
          case "subagent":
            return <AnswerSubagent block={block} key={block.key} />;
          default:
            block satisfies never;
            return panic("Unhandled answer block");
        }
      })}
      {entry.failure === undefined ? null : (
        <FailedAnswer failure={entry.failure} onRetry={onRetry} />
      )}
      {live || entry.text === "" ? null : <ShareAnswer text={entry.text} />}
    </View>
  );
};

/** Why an answer failed, and a way to ask again when the thread offers one. */
const FailedAnswer = ({
  failure,
  onRetry,
}: {
  failure: AIErrorKind;
  onRetry: (() => void) | undefined;
}) => {
  const t = useTranslations("chat");
  return (
    <View className="items-start gap-2">
      <Text variant="error">{t(`failure.${CHAT_FAILURE_KEYS[failure]}`)}</Text>
      {onRetry === undefined ? null : (
        <Button onPress={onRetry} variant="outline">
          {t("resend")}
        </Button>
      )}
    </View>
  );
};

/** What the answer's context left out, in the words the web uses. */
const ContextNotice = ({ notice }: { notice: ChatContextNotice }) => {
  const t = useTranslations("chat");
  switch (notice.type) {
    case "history-trimmed":
      return <Text variant="caption">{t("historyTrimmed")}</Text>;
    case "session-not-resumed":
      return <Text variant="caption">{t("localRun.sessionNotResumed")}</Text>;
    default:
      notice satisfies never;
      return panic("Unhandled context notice");
  }
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
