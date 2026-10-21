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

export type MobileMessages = typeof en;

/**
 * Every UI locale the web app ships, keyed by the one list in
 * `@stll/locales`, so the app cannot gain or lose a language alone. Each
 * catalogue is typed by the English one, so a missing key fails typecheck;
 * `catalogs.test.ts` also refuses extra keys and drifted placeholders.
 * The catalogues are small enough to bundle whole.
 */
export const CATALOGS = {
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
} as const satisfies Record<UiLocale, MobileMessages>;
