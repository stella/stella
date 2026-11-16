// The words of the timer's Live Activity, one catalogue per language: the
// app shows them on its timers and on the Lock Screen, and the server writes
// them into the updates it sends a phone. One source, so the Lock Screen
// reads the same whichever side last drew it.

import ar from "./timer-activity-messages/ar.json";
import cs from "./timer-activity-messages/cs.json";
import de from "./timer-activity-messages/de.json";
import en from "./timer-activity-messages/en.json";
import es from "./timer-activity-messages/es.json";
import et from "./timer-activity-messages/et.json";
import fr from "./timer-activity-messages/fr.json";
import hu from "./timer-activity-messages/hu.json";
import lt from "./timer-activity-messages/lt.json";
import lv from "./timer-activity-messages/lv.json";
import pl from "./timer-activity-messages/pl.json";
import ptBR from "./timer-activity-messages/pt-BR.json";
import sk from "./timer-activity-messages/sk.json";

/** Typed by the English catalogue, so a language missing a word fails typecheck. */
export type TimerActivityMessages = typeof en;

/**
 * Keyed like `@stll/locales`' UI locales; each consumer holds the record to
 * that list with `satisfies Record<UiLocale, TimerActivityMessages>`.
 */
export const TIMER_ACTIVITY_MESSAGES = {
  ar,
  cs,
  de,
  en,
  es,
  et,
  fr,
  hu,
  lt,
  lv,
  pl,
  "pt-BR": ptBR,
  sk,
} as const satisfies Record<string, TimerActivityMessages>;
