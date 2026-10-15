import type { ReactNode } from "react";

import { createTranslator } from "use-intl";

import type { ReaderMessages } from "@stll/decision-reader/reader-adapters";

import catalogues from "../shared/generated/reader-messages.json";
import { appLocale } from "../shared/locale";

export const readerMessages = (hostLocale: string | undefined) => {
  const { locale, formattingLocale } = appLocale(hostLocale);
  const messages = catalogues[locale];
  const t = createTranslator({
    locale: formattingLocale,
    messages: {
      sourceAttribution: messages["caseLaw.reader.sourceAttribution"],
      dissentByline: messages["caseLaw.viewer.dissentByline"],
      wordingValidFrom: messages["statutes.wordingValidFrom"],
    },
  });
  return {
    ...messages,
    sourceAttribution: (source, link): ReactNode =>
      t.rich("sourceAttribution", { source, link }),
    dissentByline: (names): ReactNode =>
      t.rich("dissentByline", {
        names: new Intl.ListFormat(formattingLocale).format([...names]),
        bdi: (children) => <bdi>{children}</bdi>,
      }),
    wordingValidFrom: (date) => t("wordingValidFrom", { date }),
    formatValidityDate: (date) =>
      date === null
        ? null
        : new Intl.DateTimeFormat(formattingLocale, {
            dateStyle: "medium",
            timeZone: "UTC",
          }).format(new Date(date)),
  } satisfies ReaderMessages;
};
