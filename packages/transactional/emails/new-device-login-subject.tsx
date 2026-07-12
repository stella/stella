import { getTranslator } from "../i18n/translate";
import type { SupportedLang } from "../i18n/translate";

export const subject = (lang: SupportedLang) =>
  getTranslator(lang)("newDeviceLogin.subject");
