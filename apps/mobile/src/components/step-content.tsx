import { Suspense, use, useState, useTransition } from "react";
import type { ReactNode } from "react";

import { panic } from "better-result";
import {
  ActivityIndicator,
  Image,
  Platform,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { useFormatter, useTranslations } from "use-intl";

import {
  CHAT_LOCAL_RUN_STEP_CONTENT_STATE,
  chatLocalRunStepContentCap,
} from "@stll/api-contract/chat-local-run-step-content";
import {
  diffLines,
  type DiffLineTone,
  localRunConversationEntries,
  type LocalRunStepOutputView,
} from "@stll/api-contract/chat-local-run-step-content-view";
import type { ChatLocalRunConversationEntry } from "@stll/api-contract/chat-local-run-step-output";
import { Button } from "@stll/ui/button";
import { formatFileSize } from "@stll/ui/file-size";
import { Text } from "@stll/ui/text";

import { MarkdownView } from "@/components/markdown-view";
import { ThreadSteps } from "@/components/thread-steps";
import { useSession } from "@/connection/session-provider";
import {
  hasMoreStepText,
  readStepContent,
  STEP_CONTENT_UNREAD,
} from "@/state/chat-step-content";
import type { StepContentRead } from "@/state/chat-step-content";
import { useAppColors, useUiColors } from "@/theme";
import type { UiColors } from "@/ui-theme.gen";

const MONOSPACE = Platform.select({ ios: "Menlo", default: "monospace" });

/** How tall a step's content stands before it scrolls on its own. */
const CONTENT_MAX_HEIGHT = 320;

/**
 * What a coding agent's settled step produced on the person's computer, as
 * stella stores it with the conversation and the web shows it: a command's
 * output, a change's diff, a subagent's conversation as the answer's
 * markdown, the image a step viewed, or why there is nothing to show. A text
 * opens on its first window; the rest comes when the person asks for it.
 */
export const StepContentView = ({
  callId,
  name,
}: {
  callId: string;
  /** The file's name as the step shows it, for an image. */
  name: string;
}) => {
  const thread = use(ThreadSteps) ?? panic("A step's content needs its thread");
  const { end } = useSession();
  const colors = useAppColors();
  const read = async (from: StepContentRead) => {
    const next = await readStepContent({
      callId,
      fetch,
      read: from,
      source: thread.source,
      threadId: thread.threadId,
    });
    if (next.type === "failed" && next.error._tag === "SignedOutError") {
      end(thread.source);
    }
    return next;
  };
  const [load, setLoad] = useState(() => read(STEP_CONTENT_UNREAD));
  const [reading, startReading] = useTransition();

  return (
    <Suspense
      fallback={
        <ActivityIndicator
          color={colors.muted}
          size="small"
          style={styles.pending}
        />
      }
    >
      <ReadContent
        load={load}
        name={name}
        onReadOn={(from) => {
          startReading(() => {
            setLoad(read(from));
          });
        }}
        reading={reading}
      />
    </Suspense>
  );
};

const ReadContent = ({
  load,
  name,
  onReadOn,
  reading,
}: {
  load: Promise<StepContentRead>;
  name: string;
  onReadOn: (from: StepContentRead) => void;
  reading: boolean;
}) => {
  const t = useTranslations("chat.localRun.output");
  const tChat = useTranslations("chat");
  const format = useFormatter();
  const read = use(load);
  const [imageFailed, setImageFailed] = useState(false);
  const retry = (
    <Button
      loading={reading}
      onPress={() => {
        setImageFailed(false);
        onReadOn(read);
      }}
      size="sm"
      variant="ghost"
    >
      {tChat("retry")}
    </Button>
  );
  // A read that failed keeps what came before it, and says so.
  const failed =
    read.type === "failed" ? (
      <Note action={retry} text={t("loadFailed")} />
    ) : null;
  const { view } = read;
  switch (view.status) {
    case "unread":
      // Only a first read that failed leaves nothing read.
      return failed ?? panic("A step read answered nothing");
    case "text":
      return (
        <View style={styles.content}>
          <StepText view={view} />
          {hasMoreStepText(view) && read.type === "read" ? (
            <Button
              className="self-start"
              loading={reading}
              onPress={() => {
                onReadOn(read);
              }}
              size="sm"
              variant="ghost"
            >
              {t("showMore")}
            </Button>
          ) : null}
          {failed}
        </View>
      );
    case "answered":
      break;
    default:
      view satisfies never;
      return panic("Unhandled step content view");
  }
  const { content } = view;
  switch (content.state) {
    case CHAT_LOCAL_RUN_STEP_CONTENT_STATE.stored:
      if (read.image === null) {
        return panic("A stored step image has no source");
      }
      return imageFailed ? (
        <Note action={retry} text={t("loadFailed")} />
      ) : (
        <Image
          accessibilityIgnoresInvertColors
          accessibilityLabel={name}
          onError={() => {
            setImageFailed(true);
          }}
          resizeMode="contain"
          source={read.image}
          style={styles.image}
        />
      );
    case CHAT_LOCAL_RUN_STEP_CONTENT_STATE.arriving:
      // The computer may send it any time: the person can look again
      // without folding the step.
      return (
        <Note
          action={retry}
          text={read.type === "failed" ? t("loadFailed") : t("arriving")}
        />
      );
    case CHAT_LOCAL_RUN_STEP_CONTENT_STATE.notCopied:
      return <Note text={t("notCopied")} />;
    case CHAT_LOCAL_RUN_STEP_CONTENT_STATE.notStored:
      return <Note text={t("notStored")} />;
    case CHAT_LOCAL_RUN_STEP_CONTENT_STATE.runBudgetReached:
      return <Note text={t("runBudgetReached")} />;
    case CHAT_LOCAL_RUN_STEP_CONTENT_STATE.tooLarge:
      return (
        <Note
          text={t("imageTooLargeToStore", {
            kept: formatFileSize(
              chatLocalRunStepContentCap(content.kind),
              format,
            ),
            total: formatFileSize(content.totalBytes, format),
          })}
        />
      );
    default:
      content satisfies never;
      return panic("Unhandled step content state");
  }
};

/** A line under the step that says why it shows nothing, or no more. */
const Note = ({ action, text }: { action?: ReactNode; text: string }) => {
  const colors = useAppColors();
  return (
    <View style={styles.note}>
      <Text style={[styles.noteText, { color: colors.muted }]}>{text}</Text>
      {action}
    </View>
  );
};

const TEXT_KIND_LABEL_KEYS = {
  command: "command",
  diff: "diff",
  conversation: "conversation",
} as const satisfies Record<
  Extract<LocalRunStepOutputView, { status: "text" }>["kind"],
  string
>;

/** A stored text: the output or diff as the computer printed it, or a conversation. */
const StepText = ({
  view,
}: {
  view: Extract<LocalRunStepOutputView, { status: "text" }>;
}) => {
  const t = useTranslations("chat.localRun.output");
  const format = useFormatter();
  const colors = useAppColors();
  const ui = useUiColors();
  if (view.text === "" && !hasMoreStepText(view)) {
    return <Note text={t("empty")} />;
  }
  const cut =
    view.storedBytes < view.totalBytes ? (
      <Note
        text={t("cut", {
          kept: formatFileSize(view.storedBytes, format),
          total: formatFileSize(view.totalBytes, format),
        })}
      />
    ) : null;
  return (
    <View accessibilityLabel={t(TEXT_KIND_LABEL_KEYS[view.kind])}>
      <ScrollView
        nestedScrollEnabled
        style={[
          styles.text,
          { backgroundColor: colors.card, borderColor: colors.border },
        ]}
      >
        {view.kind === "conversation" ? (
          <ConversationText text={view.text} />
        ) : (
          <Text selectable style={[styles.code, { color: ui.foregroundMuted }]}>
            {view.kind === "diff" ? (
              <DiffText text={view.text} ui={ui} />
            ) : (
              view.text
            )}
          </Text>
        )}
      </ScrollView>
      {cut}
    </View>
  );
};

/** The theme colour each tone of a diff line reads in, as on the web. */
const DIFF_TONE_COLORS = {
  file: "foreground",
  hunk: "foregroundGhost",
  added: "success",
  removed: "destructive",
  context: "foregroundMuted",
} as const satisfies Record<DiffLineTone, keyof UiColors>;

/** A stored diff, each line in its tone up to a bound, the rest as one block. */
const DiffText = ({ text, ui }: { text: string; ui: UiColors }) => {
  const { lines, rest } = diffLines(text);
  return (
    <>
      {lines.map(({ key, line, tone }, index) => (
        <Text
          key={key}
          style={{
            color: ui[DIFF_TONE_COLORS[tone]],
            fontWeight: tone === "file" ? "500" : "400",
          }}
        >
          {index === 0 ? "" : "\n"}
          {line}
        </Text>
      ))}
      {rest === "" ? null : `\n${rest}`}
    </>
  );
};

/** Who said a piece of a subagent's conversation; what it wrote is unnamed. */
const CONVERSATION_ROLE_LABEL_KEYS = {
  prompt: "conversationPrompt",
  message: null,
  report: "conversationReport",
} as const satisfies Record<
  ChatLocalRunConversationEntry["role"],
  string | null
>;

/**
 * A subagent's stored conversation: what it was told, what it wrote, what it
 * reported, drawn as the answer it belongs to is. It came from a model, and
 * the markdown view draws no image from an address.
 */
const ConversationText = ({ text }: { text: string }) => {
  const t = useTranslations("chat.localRun.output");
  const colors = useAppColors();
  return (
    <View style={styles.conversation}>
      {localRunConversationEntries(text).map(({ key, role, text: said }) => {
        const labelKey = CONVERSATION_ROLE_LABEL_KEYS[role];
        return (
          <View key={key} style={styles.entry}>
            {labelKey === null ? null : (
              <Text style={[styles.role, { color: colors.muted }]}>
                {t(labelKey)}
              </Text>
            )}
            <MarkdownView markdown={said} />
          </View>
        );
      })}
    </View>
  );
};

const styles = StyleSheet.create({
  // Output and diffs read as the computer printed them, in an Arabic UI too.
  code: {
    fontFamily: MONOSPACE,
    fontSize: 12,
    lineHeight: 18,
    textAlign: "left",
    writingDirection: "ltr",
  },
  content: {
    alignSelf: "stretch",
    gap: 4,
  },
  conversation: {
    gap: 10,
  },
  entry: {
    gap: 2,
  },
  image: {
    alignSelf: "stretch",
    height: 240,
  },
  note: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  noteText: {
    fontSize: 13,
    lineHeight: 18,
  },
  pending: {
    alignSelf: "flex-start",
  },
  role: {
    fontSize: 12,
    fontWeight: "500",
  },
  text: {
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    maxHeight: CONTENT_MAX_HEIGHT,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
});
