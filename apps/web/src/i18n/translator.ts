import { createTranslator } from "use-intl/core";

import en from "@/i18n/langs/en.json";

let translator = createTranslator({ locale: "en", messages: en });

export const getTranslator = () => translator;

export const setTranslator = (next: typeof translator): void => {
  translator = next;
};
