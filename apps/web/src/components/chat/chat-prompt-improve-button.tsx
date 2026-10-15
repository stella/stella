import { useState } from "react";

import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";
import {
  CHAT_PROMPT_IMPROVEMENT_STRATEGY,
  type ChatPromptImprovementStrategy,
} from "@stll/api-contract/chat";
import { AiActionIcon } from "@stll/ui/icons";
import { Loader } from "@stll/ui/loader";
import { MenuItem, MenuPopup } from "@stll/ui/menu";
import { SplitButton } from "@stll/ui/split-button";
import { stellaToast } from "@stll/ui/toast";

import type { ChatEditorController } from "@/components/chat-editor-provider";
import { composerStoredMarkdown } from "@/components/chat-editor-source";
import type { TranslationKey } from "@/i18n/types";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { detached } from "@/lib/detached";
import { unwrapEden } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";

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
      notifyUserError(result.error, t("common.somethingWentWrong"));
      return;
    }
    if (!isCurrentDraftUnchanged({ controller, editor, prompt })) {
      stellaToast.add({
        title: t("chat.improvePromptDraftChanged"),
        type: "info",
      });
      return;
    }

    controller.setContent(composerStoredMarkdown(result.value.prompt));
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
    <SplitButton
      primaryLabel={label}
      menuLabel={t("chat.choosePromptImprovementStrategy")}
      primaryDisabled={unavailable}
      menuDisabled={unavailable}
      open={open}
      onOpenChange={setOpen}
      onPrimaryClick={() =>
        runImprovement(CHAT_PROMPT_IMPROVEMENT_STRATEGY.structure)
      }
      menu={
        <MenuPopup align="end" className="w-[min(20rem,calc(100vw-2rem))]">
          {PROMPT_IMPROVEMENT_OPTIONS.map((option) => (
            <MenuItem
              className="min-h-12 flex-col items-start gap-0.5 px-3 py-2 text-start whitespace-normal"
              key={option.strategy}
              onClick={() => runImprovement(option.strategy)}
            >
              <span className="font-medium">{t(option.labelKey)}</span>
              <span className="text-muted-foreground text-xs leading-snug font-normal">
                {t(option.descriptionKey)}
              </span>
            </MenuItem>
          ))}
        </MenuPopup>
      }
    >
      {isPending ? (
        <Loader className="size-3.5" label={t("common.loading")} size="sm" />
      ) : (
        <AiActionIcon aria-hidden="true" className="size-3.5" />
      )}
    </SplitButton>
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
