import { useTranslations } from "use-intl";

import {
  type LocalRunToolSubtitle,
  localRunToolSubtitleText,
} from "@stll/api-contract/chat-local-run-steps";

/**
 * A coding agent's step as its row and its approval card name it, in the
 * member's language: the one place the web puts a step's values into its
 * sentences.
 */
export const useLocalRunSubtitleText = () => {
  const t = useTranslations("chat.toolCall");
  return (subtitle: LocalRunToolSubtitle | null): string | null =>
    localRunToolSubtitleText(subtitle, {
      patternInPath: (values) => t("patternInPath", values),
      commandExited: (values) => t("commandExited", values),
      browserClick: (values) => t("browserClick", values),
      browserType: (values) => t("browserType", values),
      browserPressKey: (values) => t("browserPressKey", values),
      browserSelect: (values) => t("browserSelect", values),
    });
};
