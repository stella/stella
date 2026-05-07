import { createTranslator } from "use-intl/core";

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
import ptBr from "./langs/pt-BR.json";
import sk from "./langs/sk.json";

const langMessages = {
  en,
  cs,
  de,
  es,
  et,
  fr,
  hu,
  lt,
  lv,
  pl,
  "pt-BR": ptBr,
  sk,
} as const;

export type SupportedLang = keyof typeof langMessages;

export const getTranslator = (lang: SupportedLang) =>
  createTranslator({
    locale: lang,
    messages: langMessages[lang],
  });
