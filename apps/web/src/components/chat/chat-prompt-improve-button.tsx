import { useState } from "react";

import { Result } from "better-result";
import { ChevronDownIcon, Loader2Icon, WandSparklesIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";
import {
  CHAT_PROMPT_IMPROVEMENT_STRATEGY,
  type ChatPromptImprovementStrategy,
} from "@stll/api-contract/chat";
import { Button } from "@stll/ui/components/button";
import {
  Popover,
  PopoverPopup,
  PopoverTrigger,
} from "@stll/ui/components/popover";
import { stellaToast } from "@stll/ui/components/toast";

import type { ChatEditorController } from "@/components/chat-editor-provider";
import type { TranslationKey } from "@/i18n/types";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { detached } from "@/lib/detached";
import { unwrapEden } from "@/lib/errors/api";

type ChatPromptImproveButtonProps = {
  anonymized: boolean;
  controller: ChatEditorController;
  disabled: boolean;
};

const PROMPT_IMPROVEMENT_OPTIONS = [
  {
    descriptionKey: "chat.promptImprovementStrategies.structure.description",
    labelKey: "chat.promptImprovementStrategies.structure.label",
    strategy: CHAT_PROMPT_IMPROVEMENT_STRATEGY.structure,
  },
  {
    descriptionKey:
      "chat.promptImprovementStrategies.specifyOutput.description",
    labelKey: "chat.promptImprovementStrategies.specifyOutput.label",
    strategy: CHAT_PROMPT_IMPROVEMENT_STRATEGY.specifyOutput,
  },
  {
    descriptionKey: "chat.promptImprovementStrategies.decompose.description",
    labelKey: "chat.promptImprovementStrategies.decompose.label",
    strategy: CHAT_PROMPT_IMPROVEMENT_STRATEGY.decompose,
  },
  {
    descriptionKey: "chat.promptImprovementStrategies.verify.description",
    labelKey: "chat.promptImprovementStrategies.verify.label",
    strategy: CHAT_PROMPT_IMPROVEMENT_STRATEGY.verify,
  },
] as const satisfies readonly {
  descriptionKey: TranslationKey;
  labelKey: TranslationKey;
  strategy: ChatPromptImprovementStrategy;
}[];

type MissingPromptImprovementOption = Exclude<
  ChatPromptImprovementStrategy,
  (typeof PROMPT_IMPROVEMENT_OPTIONS)[number]["strategy"]
>;

true satisfies MissingPromptImprovementOption extends never ? true : never;

export const ChatPromptImproveButton = ({
  anonymized,
  controller,
  disabled,
}: ChatPromptImproveButtonProps) => {
  const t = useTranslations();
  const [isPending, setIsPending] = useState(false);
  const [open, setOpen] = useState(false);

  const improvePrompt = async (strategy: ChatPromptImprovementStrategy) => {
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
        strategy,
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

  const runImprovement = (strategy: ChatPromptImprovementStrategy) => {
    if (anonymized || disabled || isPending) {
      return;
    }
    setOpen(false);
    detached(
      improvePrompt(strategy),
      "chat-prompt-improve-button.improve-prompt",
    );
  };

  let label = t("chat.improvePrompt");
  if (anonymized) {
    label = t("chat.improvePromptUnavailableAnonymized");
  }
  if (isPending) {
    label = t("chat.improvingPrompt");
  }

  const unavailable = anonymized || disabled || isPending;

  return (
    <div
      className="text-muted-foreground hover:text-foreground inline-flex shrink-0 items-center"
      data-slot="chat-prompt-improve-control"
    >
      <Button
        aria-label={label}
        className="size-11 max-w-11 flex-none rounded-e-none"
        disabled={unavailable}
        onClick={() =>
          runImprovement(CHAT_PROMPT_IMPROVEMENT_STRATEGY.structure)
        }
        size="icon-sm"
        tooltip={label}
        type="button"
        variant="ghost"
      >
        {isPending ? (
          <Loader2Icon
            aria-hidden
            className="size-3.5 animate-spin ltr:translate-x-1 rtl:-translate-x-1"
          />
        ) : (
          <WandSparklesIcon
            aria-hidden
            className="size-3.5 ltr:translate-x-1 rtl:-translate-x-1"
          />
        )}
      </Button>
      <Popover onOpenChange={setOpen} open={open}>
        <PopoverTrigger
          render={
            <Button
              aria-label={t("chat.choosePromptImprovementStrategy")}
              className="size-11 max-w-11 flex-none rounded-s-none border-s px-1"
              disabled={unavailable}
              size="icon-sm"
              tooltip={t("chat.choosePromptImprovementStrategy")}
              type="button"
              variant="ghost"
            />
          }
        >
          <ChevronDownIcon
            aria-hidden
            className="size-3 ltr:-translate-x-1 rtl:translate-x-1"
          />
        </PopoverTrigger>
        <PopoverPopup align="end" className="w-80 p-1" side="bottom">
          <div className="flex flex-col gap-0.5">
            {PROMPT_IMPROVEMENT_OPTIONS.map((option) => (
              <Button
                className="h-auto min-h-12 w-full flex-col items-start gap-0.5 px-3 py-2 text-start whitespace-normal sm:h-auto"
                key={option.strategy}
                onClick={() => runImprovement(option.strategy)}
                size="sm"
                type="button"
                variant="ghost"
              >
                <span className="font-medium">{t(option.labelKey)}</span>
                <span className="text-muted-foreground text-xs leading-snug font-normal">
                  {t(option.descriptionKey)}
                </span>
              </Button>
            ))}
          </div>
        </PopoverPopup>
      </Popover>
    </div>
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
