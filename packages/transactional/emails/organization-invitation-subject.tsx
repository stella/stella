import { getTranslator } from "../i18n/translate";
import type { SupportedLang } from "../i18n/translate";

export const subject = (
  lang: SupportedLang,
  { organizationName }: { organizationName: string },
) => getTranslator(lang)("invitation.subject", { organizationName });
