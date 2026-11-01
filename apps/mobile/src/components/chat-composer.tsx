import { useState } from "react";

import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { useTranslations } from "use-intl";

import { CHAT_CONTEXT_FILE_MAX_MEGABYTES } from "@stll/chat-limits";
import { COMPOSER_BOX_CLASS } from "@stll/ui/composer-tokens";
import { Text } from "@stll/ui/text";
import { Textarea } from "@stll/ui/textarea";

import { ChatAttachmentChip } from "@/components/chat-attachment-chip";
import { ComposerAttachMenu } from "@/components/composer-attach-menu";
import { useChatAttachments } from "@/components/use-chat-attachments";
import type { AttachmentNotice } from "@/components/use-chat-attachments";
import { useDictation } from "@/components/use-dictation";
import type { DictationNotice } from "@/components/use-dictation";
import {
  ArrowUpIcon,
  CheckIcon,
  DictateIcon,
  SquareIcon,
  XIcon,
} from "@/icons.gen";
import type { LucideIcon } from "@/icons.gen";
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
import { appendDictation, DICTATION_MAX_SECONDS } from "@/state/dictation";
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
 *
 * With nothing to send, the round button is a microphone instead: it records
 * until the person taps done (or for a minute at most), and the transcribed
 * text lands in the box to read over before sending.
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
  const t = useTranslations("chat");
  const [draft, setDraft] = useState("");
  const files = useChatAttachments();
  const dictation = useDictation((text) => {
    setDraft((typed) => appendDictation(typed, text));
  });
  const message = draft.trim();
  const notice = useNoticeText(files.notice, dictation.notice, sendError);
  const hasDraft = message !== "" || files.attachments.length > 0;
  const canSend = hasDraft && attachmentsSendable(files.attachments);

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

  // The round button: done while dictating, stop while an answer arrives,
  // send once there is something to send, else the microphone.
  let action: RoundButtonProps;
  if (dictation.phase !== "idle") {
    action = {
      enabled: dictation.phase === "recording",
      Icon: CheckIcon,
      label: t("dictationFinish"),
      onPress: dictation.finish,
    };
  } else if (busy) {
    action = {
      enabled: canStop,
      Icon: SquareIcon,
      iconSize: 16,
      label: t("stop"),
      onPress: onStop,
    };
  } else if (hasDraft) {
    action = {
      enabled: canSend,
      Icon: ArrowUpIcon,
      label: t("send"),
      onPress: send,
    };
  } else {
    action = {
      enabled: true,
      filled: false,
      Icon: DictateIcon,
      label: t("dictate"),
      onPress: dictation.start,
    };
  }

  // iOS 26's Liquid Glass: the box is a glass capsule floating over the
  // screen, as the platform's own message fields are. Elsewhere it keeps the
  // web's bordered box.
  const glass = Platform.OS === "ios" && isLiquidGlassAvailable();
  const Box = glass ? GlassBox : BorderedBox;

  return (
    <View className={`${glass ? "" : "bg-background"} gap-1 px-3 pt-1 pb-2`}>
      {notice === undefined ? null : (
        <Text accessibilityLiveRegion="polite" className="px-1" variant="error">
          {notice}
        </Text>
      )}
      <Box>
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
          {dictation.phase === "idle" ? (
            <ComposerAttachMenu
              onAttachFile={files.pickDocument}
              onScan={canScan() ? files.scanDocument : undefined}
            />
          ) : (
            <RoundButton
              enabled={dictation.phase === "recording"}
              filled={false}
              Icon={XIcon}
              label={t("dictationCancel")}
              onPress={dictation.cancel}
            />
          )}
          <View className="min-w-0 flex-1 py-2.25">
            {dictation.phase === "idle" ? (
              <Textarea
                accessibilityLabel={t("composerPlaceholder")}
                onChangeText={setDraft}
                placeholder={t("composerPlaceholder")}
                unstyled
                value={draft}
              />
            ) : (
              <Text
                accessibilityLiveRegion="polite"
                className="text-muted-foreground"
                variant="body"
              >
                {dictation.phase === "recording"
                  ? t("dictationListening", {
                      elapsed: clock(dictation.elapsedMs),
                      limit: clock(DICTATION_MAX_SECONDS * 1000),
                    })
                  : t("dictationTranscribing")}
              </Text>
            )}
          </View>
          <RoundButton {...action} />
        </View>
      </Box>
    </View>
  );
};

// A one-line text cell is 42pt tall (24pt line, 9pt above and below); the
// 36pt round controls sit centred on it.
const ROUND =
  "mb-[3px] size-9 shrink-0 items-center justify-center rounded-full";

type RoundButtonProps = {
  readonly enabled: boolean;
  /**
   * Drawn in the foreground colour when ready; by default only when
   * enabled, so a button with nothing to do is muted rather than dimmed and
   * never reads as ready.
   */
  readonly filled?: boolean;
  readonly Icon: LucideIcon;
  readonly iconSize?: number;
  readonly label: string;
  readonly onPress: () => void;
};

/** One of the composer's round controls. */
const RoundButton = ({
  enabled,
  filled = enabled,
  Icon,
  iconSize = 18,
  label,
  onPress,
}: RoundButtonProps) => {
  const ui = useUiColors();
  let color: string = ui.mutedForeground;
  if (filled) {
    color = ui.background;
  } else if (enabled) {
    color = ui.foreground;
  }
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled: !enabled }}
      className={`${ROUND} ${filled ? "bg-foreground" : "bg-secondary"}`}
      disabled={!enabled}
      onPress={onPress}
    >
      <Icon color={color} size={iconSize} />
    </Pressable>
  );
};

/** The web's bordered message box, from its composer tokens. */
const BorderedBox = ({ children }: React.PropsWithChildren) => (
  <View className={`${COMPOSER_BOX_CLASS} border-border`}>{children}</View>
);

/** The message box as a Liquid Glass capsule. */
const GlassBox = ({ children }: React.PropsWithChildren) => (
  <GlassView glassEffectStyle="regular" isInteractive style={styles.glass}>
    {children}
  </GlassView>
);

/** What the composer says went wrong: with a dictation, a file just added, else the last send. */
function useNoticeText(
  notice: AttachmentNotice | undefined,
  dictationNotice: DictationNotice | undefined,
  sendError: SendRefusal | undefined,
): string | undefined {
  const t = useTranslations("chat");
  const scanT = useTranslations("scan");
  if (dictationNotice !== undefined) {
    const dictationText = {
      denied: t("dictationDenied"),
      failed: t("dictationFailed"),
      silent: t("dictationSilent"),
    } as const satisfies Record<DictationNotice, string>;
    return dictationText[dictationNotice];
  }
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

/** Minutes and seconds, as a recorder counts: 0:07, 1:00. */
const clock = (milliseconds: number): string => {
  const seconds = Math.floor(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
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
  // Rounded to half the one-line row (54pt), so one line reads as a capsule.
  glass: {
    borderRadius: 27,
  },
  chips: {
    gap: 8,
    paddingHorizontal: 8,
    paddingTop: 8,
  },
});
