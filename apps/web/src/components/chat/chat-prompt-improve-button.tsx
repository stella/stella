import { useState } from "react";

import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";
import { stellaToast } from "@stll/ui/components/toast";

import { AiRewriteControl } from "@/components/ai-rewrite-control";
import type { ChatEditorController } from "@/components/chat-editor-provider";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { detached } from "@/lib/detached";
import { unwrapEden } from "@/lib/errors/api";

type ChatPromptImproveButtonProps = {
  anonymized: boolean;
  controller: ChatEditorController;
  disabled: boolean;
};

export const ChatPromptImproveButton = ({
  anonymized,
  controller,
  disabled,
}: ChatPromptImproveButtonProps) => {
  const t = useTranslations();
  const [isPending, setIsPending] = useState(false);

  const improvePrompt = async (instruction: string) => {
    const { editor } = controller;
    if (!editor || editor.isDestroyed || !isPlainTextDraft(editor)) {
      stellaToast.add({
        title: t("chat.improvePromptPlainTextOnly"),
        type: "warning",
      });
      return;
    }

    const prompt = editor.getText().trim();
    if (!prompt) {
      return;
    }

    setIsPending(true);
    const result = await Result.tryPromise(async () => {
      const response = await api.chat["improve-prompt"].post({
        prompt,
        instruction,
        sendMode: anonymized
          ? CHAT_SEND_MODE.anonymized
          : CHAT_SEND_MODE.rawOverride,
      });
      return unwrapEden(response);
    });
    setIsPending(false);

    if (Result.isError(result)) {
      getAnalytics().captureError(result.error);
      stellaToast.add({
        title: t("common.somethingWentWrong"),
        type: "error",
      });
      return;
    }
    if (!isCurrentDraftUnchanged({ controller, editor, prompt })) {
      stellaToast.add({
        title: t("chat.improvePromptDraftChanged"),
        type: "info",
      });
      return;
    }

    controller.setContent(result.value.prompt);
    controller.focus();
  };

  let label = t("chat.improvePrompt");
  if (anonymized) {
    label = t("chat.improvePromptUnavailableAnonymized");
  }
  if (isPending) {
    label = t("chat.improvingPrompt");
  }

  return (
    <AiRewriteControl
      className="text-muted-foreground hover:text-foreground"
      disabled={anonymized || disabled}
      isPending={isPending}
      label={label}
      onRewrite={(instruction) => {
        detached(
          improvePrompt(instruction),
          "ChatPromptImproveButton.improvePrompt",
        );
      }}
    />
  );
};

const PLAIN_TEXT_NODE_NAMES = [
  "doc",
  "hardBreak",
  "paragraph",
  "text",
] as const;

const isPlainTextDraft = (
  editor: NonNullable<ChatEditorController["editor"]>,
): boolean => {
  let isPlainText = true;
  editor.state.doc.descendants((node) => {
    if (!PLAIN_TEXT_NODE_NAMES.some((name) => name === node.type.name)) {
      isPlainText = false;
      return false;
    }
    return isPlainText;
  });
  return isPlainText;
};

const isCurrentDraftUnchanged = ({
  controller,
  editor,
  prompt,
}: {
  controller: ChatEditorController;
  editor: NonNullable<ChatEditorController["editor"]>;
  prompt: string;
}): boolean => {
  const currentEditor = controller.editor;
  return (
    currentEditor === editor &&
    !currentEditor.isDestroyed &&
    currentEditor.getText().trim() === prompt
  );
};
