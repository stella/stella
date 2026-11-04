import { createTranslator } from "use-intl/core";

import type { TimerActivityLabels } from "@stll/api-contract/timer-activity";
import { TIMER_ACTIVITY_MESSAGES } from "@stll/api-contract/timer-activity-messages";
import type { TimerActivityMessages } from "@stll/api-contract/timer-activity-messages";
import type { UiLocale } from "@stll/locales";

const MESSAGES: Record<UiLocale, TimerActivityMessages> =
  TIMER_ACTIVITY_MESSAGES;

/**
 * The words of the timer's Live Activity in `lang`, from the catalogue the
 * app draws the same activity with, and the sentence that announces an
 * activity the server starts. The sentence names nothing: it passes through
 * Apple even on a phone that lets updates name the timer.
 */
export const timerActivityLabels = (
  lang: UiLocale,
): TimerActivityLabels & { startedElsewhere: string } => {
  const t = createTranslator({ locale: lang, messages: MESSAGES[lang] });
  return {
    more: (count) => t("more", { count }),
    noDescription: t("noDescription"),
    noMatter: t("noMatter"),
    pause: t("pause"),
    paused: t("paused"),
    resume: t("resume"),
    running: t("running"),
    startedElsewhere: t("startedElsewhere"),
    timer: t("timer"),
  };
};
