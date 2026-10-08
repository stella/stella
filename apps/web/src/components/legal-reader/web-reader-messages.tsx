import type { ReactNode } from "react";

import { useTranslations } from "use-intl";

import type { ReaderMessages } from "@stll/decision-reader/reader-adapters";
import { BidiText } from "@stll/ui/bidi-text";

import { formatValidityDate } from "@/features/statutes/statute-format";
import { useFormatter } from "@/i18n/formatting-context";

export const useWebReaderMessages = (): ReaderMessages => {
  const t = useTranslations();
  const format = useFormatter();
  return {
    "statutes.diffRemoved": t("statutes.diffRemoved"),
    "statutes.diffInserted": t("statutes.diffInserted"),
    "common.copyLink": t("common.copyLink"),
    "common.back": t("common.back"),
    "caseLaw.viewer.legalSentence": t("caseLaw.viewer.legalSentence"),
    "caseLaw.viewer.abstract": t("caseLaw.viewer.abstract"),
    "folio.comment": t("folio.comment"),
    "legalReader.annotations.highlight": t("legalReader.annotations.highlight"),
    "caseLaw.reader.headMatter": t("caseLaw.reader.headMatter"),
    "caseLaw.notesFilter.ai": t("caseLaw.notesFilter.ai"),
    "common.court": t("common.court"),
    "statutes.currentWording": t("statutes.currentWording"),
    "statutes.wordingVersionUnknown": t("statutes.wordingVersionUnknown"),
    "statutes.openProvision": t("statutes.openProvision"),
    // Explicit ReactNode: the inferred `t.rich` result carries React 19's
    // Promise<AwaitedReactNode> member, which promise-function-async flags.
    sourceAttribution: (source, link): ReactNode =>
      t.rich("caseLaw.reader.sourceAttribution", { source, link }),
    dissentByline: (names): ReactNode =>
      t.rich("caseLaw.viewer.dissentByline", {
        bdi: (chunks) => <BidiText>{chunks}</BidiText>,
        names: format.list([...names]),
      }),
    wordingValidFrom: (date) => t("statutes.wordingValidFrom", { date }),
    formatValidityDate: (date) => formatValidityDate(date, format),
  };
};
