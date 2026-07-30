import { useState } from "react";

import { Result } from "better-result";
import { Loader2Icon, WandSparklesIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { stellaToast } from "@stll/ui/components/toast";

import type { ChatEditorController } from "@/components/chat-editor-provider";
import Tooltip from "@/components/tooltip";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { detached } from "@/lib/detached";
import { toAPIError } from "@/lib/errors/api";

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

  const improvePrompt = async () => {
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
    const result = await Result.tryPromise(
      async () => await api.chat["improve-prompt"].post({ prompt }),
    );
    setIsPending(false);

    if (Result.isError(result)) {
      getAnalytics().captureError(result.error);
      stellaToast.add({
        title: t("common.somethingWentWrong"),
        type: "error",
      });
      return;
    }
    if (result.value.error) {
      getAnalytics().captureError(toAPIError(result.value.error));
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

    controller.setContent(result.value.data.prompt);
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
    <Tooltip
      content={label}
      render={
        <Button
          aria-label={label}
          className="text-muted-foreground hover:text-foreground"
          disabled={anonymized || disabled || isPending}
          onClick={() => {
            detached(improvePrompt(), "ChatPromptImproveButton");
          }}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          {isPending ? (
            <Loader2Icon aria-hidden="true" className="size-3.5 animate-spin" />
          ) : (
            <WandSparklesIcon aria-hidden="true" className="size-3.5" />
          )}
        </Button>
      }
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
