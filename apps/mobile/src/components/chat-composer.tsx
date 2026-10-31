import { useState } from "react";

import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useTranslations } from "use-intl";

import { CHAT_CONTEXT_FILE_MAX_MEGABYTES } from "@stll/chat-limits";
import { COMPOSER_BOX_CLASS } from "@stll/ui/composer-tokens";
import { Text } from "@stll/ui/text";
import { Textarea } from "@stll/ui/textarea";

import { ChatAttachmentChip } from "@/components/chat-attachment-chip";
import { ComposerAttachMenu } from "@/components/composer-attach-menu";
import { useChatAttachments } from "@/components/use-chat-attachments";
import type { AttachmentNotice } from "@/components/use-chat-attachments";
import { ArrowUpIcon, SquareIcon } from "@/icons.gen";
import { canScan } from "@/native/document-scanner";
import {
  attachmentsSendable,
  CHAT_FILES_PER_MESSAGE,
  readyFiles,
} from "@/state/chat-attachments";
import type {
  ChatAttachment,
  ChatDraft,
  SendRefusal,
} from "@/state/chat-attachments";
import { sizeInUnits } from "@/state/scan-pages";
import { useUiColors } from "@/theme";

/**
 * The message box under a thread: the web's compact composer, its box from
 * the same tokens (`@stll/ui/composer-tokens`), with the (+) control, the
 * one-line text cell that grows, and the round send button. Sized for a
 * thumb rather than a pointer: body text and 36pt controls, where the web's
 * 28pt controls and 14px text read tiny on a phone. It grows with what is
 * typed up to a few lines, then scrolls. While an answer is arriving its button stops the
 * answer instead of sending; it can stop once the server has named the turn.
 *
 * The (+) attaches files, as the web's does: a file from Files or a scanned
 * document. Each shows as a chip above the text while it is read, and goes
 * with the message once it is. What went wrong with a file, or with a send,
 * is said above the box.
 */
export const ChatComposer = ({
  busy,
  canStop,
  onSend,
  onStop,
  sendError,
}: {
  busy: boolean;
  canStop: boolean;
  /** Sends the draft; returns false when it was not taken, so it stays in the box. */
  onSend: (draft: ChatDraft, onRefused: () => void) => boolean;
  onStop: () => void;
  /** Why the last message was not sent, if it was not. */
  sendError: SendRefusal | undefined;
}) => {
  const ui = useUiColors();
  const t = useTranslations("chat");
  const [draft, setDraft] = useState("");
  const files = useChatAttachments();
  const message = draft.trim();
  const notice = useNoticeText(files.notice, sendError);
  const canSend =
    (message !== "" || files.attachments.length > 0) &&
    attachmentsSendable(files.attachments);

  const send = () => {
    if (!canSend) {
      return;
    }
    const taken = files.attachments;
    const accepted = onSend({ text: message, files: readyFiles(taken) }, () => {
      // Handed back only into an empty box, so nothing typed or attached
      // since is lost.
      setDraft((typed) => (typed === "" ? message : typed));
      files.restore(taken);
    });
    if (accepted) {
      setDraft("");
      files.clear();
    }
  };

  // A one-line text cell is 42pt tall (24pt line, 9pt above and below); the
  // 36pt round controls sit centred on it. With nothing to send, the button
  // is drawn muted rather than dimmed, so it never reads as ready.
  const round =
    "mb-[3px] size-9 shrink-0 items-center justify-center rounded-full";
  const ready = `${round} bg-foreground`;
  const muted = `${round} bg-secondary`;

  return (
    <View className="bg-background gap-1 px-3 pt-1 pb-2">
      {notice === undefined ? null : (
        <Text accessibilityLiveRegion="polite" className="px-1" variant="error">
          {notice}
        </Text>
      )}
      <View className={`${COMPOSER_BOX_CLASS} border-border`}>
        {files.attachments.length === 0 ? null : (
          <ScrollView
            contentContainerStyle={styles.chips}
            horizontal
            keyboardShouldPersistTaps="handled"
            showsHorizontalScrollIndicator={false}
          >
            {files.attachments.map((attachment) => (
              <DraftChip
                attachment={attachment}
                key={attachment.id}
                onRemove={() => {
                  files.remove(attachment.id);
                }}
              />
            ))}
          </ScrollView>
        )}
        <View className="min-h-[54px] flex-row items-end gap-2 px-2 py-1.5">
          <ComposerAttachMenu
            onAttachFile={files.pickDocument}
            onScan={canScan() ? files.scanDocument : undefined}
          />
          <View className="min-w-0 flex-1 py-2.25">
            <Textarea
              accessibilityLabel={t("composerPlaceholder")}
              onChangeText={setDraft}
              placeholder={t("composerPlaceholder")}
              unstyled
              value={draft}
            />
          </View>
          {busy ? (
            <Pressable
              accessibilityLabel={t("stop")}
              accessibilityRole="button"
              accessibilityState={{ disabled: !canStop }}
              className={canStop ? ready : muted}
              disabled={!canStop}
              onPress={onStop}
            >
              <SquareIcon
                color={canStop ? ui.background : ui.mutedForeground}
                size={16}
              />
            </Pressable>
          ) : (
            <Pressable
              accessibilityLabel={t("send")}
              accessibilityRole="button"
              accessibilityState={{ disabled: !canSend }}
              className={canSend ? ready : muted}
              disabled={!canSend}
              onPress={send}
            >
              <ArrowUpIcon
                color={canSend ? ui.background : ui.mutedForeground}
                size={18}
              />
            </Pressable>
          )}
        </View>
      </View>
    </View>
  );
};

/** What the composer says went wrong: with a file just added, else with the last send. */
function useNoticeText(
  notice: AttachmentNotice | undefined,
  sendError: SendRefusal | undefined,
): string | undefined {
  const t = useTranslations("chat");
  const scanT = useTranslations("scan");
  if (notice !== undefined) {
    const noticeText = {
      unsupported: t("unsupportedFileType"),
      "too-large": t("fileTooLarge", {
        maxSize: scanT("megabytes", { size: CHAT_CONTEXT_FILE_MAX_MEGABYTES }),
      }),
      "too-many": t("maxAttachmentsReached", { count: CHAT_FILES_PER_MESSAGE }),
      "read-failed": t("uploadFailed"),
      "pick-failed": t("pickFailed"),
      "scan-failed": scanT("failed"),
      "pdf-failed": scanT("pdfFailed"),
    } as const satisfies Record<AttachmentNotice, string>;
    return noticeText[notice];
  }
  if (sendError !== undefined) {
    const sendErrorText = {
      failed: t("sendFailed"),
      "file-refused": t("sendFileRefused"),
      "file-not-anonymizable": t("sendFileNotAnonymizable"),
    } as const satisfies Record<SendRefusal, string>;
    return sendErrorText[sendError];
  }
  return undefined;
}

/** A file in the composer: its size once read, or where it stands. */
const DraftChip = ({
  attachment,
  onRemove,
}: {
  attachment: ChatAttachment;
  onRemove: () => void;
}) => {
  const t = useTranslations("chat");
  const scanT = useTranslations("scan");
  const { status } = attachment.state;
  const size = sizeInUnits(attachment.size ?? 0);
  const detail = {
    reading: t("attachmentReading"),
    failed: t("uploadFailed"),
    ready: scanT(size.unit, { size: size.value }),
  }[status];

  return (
    <ChatAttachmentChip
      detail={detail}
      mimeType={attachment.mimeType}
      name={attachment.name}
      onRemove={onRemove}
      status={CHIP_STATUS[status]}
    />
  );
};

const CHIP_STATUS = {
  reading: "busy",
  ready: "idle",
  failed: "failed",
} as const satisfies Record<
  ChatAttachment["state"]["status"],
  React.ComponentProps<typeof ChatAttachmentChip>["status"]
>;

const styles = StyleSheet.create({
  chips: {
    gap: 8,
    paddingHorizontal: 8,
    paddingTop: 8,
  },
});
