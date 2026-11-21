import type { ComponentType, ReactNode } from "react";

import { createTranslator } from "use-intl";

import {
  CollectionAttributionList,
  type CollectionAttributionMessages,
  type CollectionBodySource,
} from "@stll/decision-reader/collection-attribution";
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
      provisionEffectiveFrom: messages["statutes.provisionEffectiveFrom"],
      provisionPartTextUnavailable:
        messages["statutes.provisionPartTextUnavailable"],
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
    provisionEffectiveFrom: (date) => t("provisionEffectiveFrom", { date }),
    provisionPartTextUnavailable: (provisionLabel) =>
      t("provisionPartTextUnavailable", { provisionLabel }),
    provisionActText: ({ statuteTitle }) => statuteTitle,
    formatLabelList: (labels) =>
      new Intl.ListFormat(formattingLocale, {
        style: "short",
        type: "unit",
      }).format([...labels]),
    formatValidityDate: (date) =>
      date === null
        ? null
        : new Intl.DateTimeFormat(formattingLocale, {
            dateStyle: "medium",
            timeZone: "UTC",
          }).format(new Date(date)),
  } satisfies ReaderMessages;
};

const readerCollectionAttributionMessages = (
  hostLocale: string | undefined,
): CollectionAttributionMessages => {
  const { locale, formattingLocale } = appLocale(hostLocale);
  const messages = catalogues[locale];
  const t = createTranslator({
    locale: formattingLocale,
    messages: {
      sourceAttribution: messages["readerCollection.sourceAttribution"],
      sourceAttributionUnknownDate:
        messages["readerCollection.sourceAttributionUnknownDate"],
      provenanceOmitted: messages["readerCollection.provenanceOmitted"],
    },
  });
  return {
    partialText: messages["readerCollection.partialText"],
    unclassifiedText: messages["readerCollection.unclassifiedText"],
    sourceAttribution: (source, date, link): ReactNode =>
      date === null
        ? t.rich("sourceAttributionUnknownDate", { source, link })
        : t.rich("sourceAttribution", { source, date, link }),
    provenanceOmitted: (counts) => t("provenanceOmitted", counts),
  };
};

type CollectionAttributionComponent = ComponentType<{
  bodySource: CollectionBodySource;
}>;
const collectionAttributionByLocale = new Map<
  string,
  CollectionAttributionComponent
>();

/** The reader's collection attribution in the host's locale, one per locale. */
export const collectionAttributionFor = (
  hostLocale: string | undefined,
): CollectionAttributionComponent => {
  const { locale } = appLocale(hostLocale);
  const cached = collectionAttributionByLocale.get(locale);
  if (cached !== undefined) {
    return cached;
  }
  const messages = readerCollectionAttributionMessages(hostLocale);
  const CollectionAttribution: CollectionAttributionComponent = ({
    bodySource,
  }) => (
    <CollectionAttributionList bodySource={bodySource} messages={messages} />
  );
  collectionAttributionByLocale.set(locale, CollectionAttribution);
  return CollectionAttribution;
};
