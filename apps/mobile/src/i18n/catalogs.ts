import { TIMER_ACTIVITY_MESSAGES } from "@stll/api-contract/timer-activity-messages";
import type { TimerActivityMessages } from "@stll/api-contract/timer-activity-messages";
import type { UiLocale } from "@stll/locales";

import ar from "./langs/ar.json";
import cs from "./langs/cs.json";
import de from "./langs/de.json";
import en from "./langs/en.json";
import es from "./langs/es.json";
import et from "./langs/et.json";
import fr from "./langs/fr.json";
import hu from "./langs/hu.json";
import lt from "./langs/lt.json";
import lv from "./langs/lv.json";
import pl from "./langs/pl.json";
import ptBR from "./langs/pt-BR.json";
import sk from "./langs/sk.json";

export type MobileMessages = typeof en & {
  /** The timer's words, shared with the server's Lock Screen updates. */
  timerActivity: TimerActivityMessages;
};

const withShared = <T extends object>(catalog: T, locale: UiLocale) => ({
  ...catalog,
  timerActivity: (
    TIMER_ACTIVITY_MESSAGES satisfies Record<UiLocale, TimerActivityMessages>
  )[locale],
});

/**
 * Every UI locale the web app ships, keyed by the one list in
 * `@stll/locales`, so the app cannot gain or lose a language alone. Each
 * catalogue is typed by the English one, so a missing key fails typecheck;
 * `catalogs.test.ts` also refuses extra keys and drifted placeholders.
 * The catalogues are small enough to bundle whole.
 */
export const CATALOGS = {
  ar: withShared(ar, "ar"),
  cs: withShared(cs, "cs"),
  de: withShared(de, "de"),
  en: withShared(en, "en"),
  es: withShared(es, "es"),
  et: withShared(et, "et"),
  fr: withShared(fr, "fr"),
  hu: withShared(hu, "hu"),
  lt: withShared(lt, "lt"),
  lv: withShared(lv, "lv"),
  pl: withShared(pl, "pl"),
  "pt-BR": withShared(ptBR, "pt-BR"),
  sk: withShared(sk, "sk"),
} as const satisfies Record<UiLocale, MobileMessages>;
