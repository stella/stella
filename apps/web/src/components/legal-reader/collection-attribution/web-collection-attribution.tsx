import type { ReactNode } from "react";

import {
  CollectionAttributionList,
  type CollectionAttributionMessages,
  type CollectionBodySource,
} from "@stll/decision-reader/collection-attribution";

import { defineFeatureCatalog } from "@/i18n/feature-catalog";

const collectionAttributionCatalog = defineFeatureCatalog({
  ar: async () => (await import("./i18n/langs/ar.json")).default,
  cs: async () => (await import("./i18n/langs/cs.json")).default,
  de: async () => (await import("./i18n/langs/de.json")).default,
  en: async () => (await import("./i18n/langs/en.json")).default,
  es: async () => (await import("./i18n/langs/es.json")).default,
  et: async () => (await import("./i18n/langs/et.json")).default,
  fr: async () => (await import("./i18n/langs/fr.json")).default,
  hu: async () => (await import("./i18n/langs/hu.json")).default,
  lt: async () => (await import("./i18n/langs/lt.json")).default,
  lv: async () => (await import("./i18n/langs/lv.json")).default,
  pl: async () => (await import("./i18n/langs/pl.json")).default,
  "pt-BR": async () => (await import("./i18n/langs/pt-BR.json")).default,
  sk: async () => (await import("./i18n/langs/sk.json")).default,
});

const CollectionAttributionWithMessages = ({
  bodySource,
}: {
  bodySource: CollectionBodySource;
}) => {
  const t = collectionAttributionCatalog.useTranslations();
  const messages: CollectionAttributionMessages = {
    partialText: t("readerCollection.partialText"),
    unclassifiedText: t("readerCollection.unclassifiedText"),
    // Explicit ReactNode: the inferred `t.rich` result carries React 19's
    // Promise<AwaitedReactNode> member, which promise-function-async flags.
    sourceAttribution: (source, date, link): ReactNode =>
      date === null
        ? t.rich("readerCollection.sourceAttributionUnknownDate", {
            source,
            link,
          })
        : t.rich("readerCollection.sourceAttribution", {
            source,
            date,
            link,
          }),
    provenanceOmitted: (counts) =>
      t("readerCollection.provenanceOmitted", counts),
  };
  return (
    <CollectionAttributionList bodySource={bodySource} messages={messages} />
  );
};

/**
 * A collection body's attribution with its strings, which load with this
 * chunk: the reader's last line, so nothing waits on them.
 */
const WebCollectionAttribution = ({
  bodySource,
}: {
  bodySource: CollectionBodySource;
}) => (
  <collectionAttributionCatalog.Provider fallback={null}>
    <CollectionAttributionWithMessages bodySource={bodySource} />
  </collectionAttributionCatalog.Provider>
);

export default WebCollectionAttribution;
