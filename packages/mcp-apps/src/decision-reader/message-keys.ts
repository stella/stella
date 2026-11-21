import type { ReaderMessageKey } from "@stll/decision-reader/reader-message-types";

export const READER_MESSAGE_KEYS = {
  "statutes.diffRemoved": "statutes.diffRemoved",
  "statutes.diffInserted": "statutes.diffInserted",
  "common.copyLink": "common.copyLink",
  "common.copied": "common.copied",
  "common.back": "common.back",
  "caseLaw.viewer.legalSentence": "caseLaw.viewer.legalSentence",
  "caseLaw.viewer.abstract": "caseLaw.viewer.abstract",
  "folio.comment": "folio.comment",
  "legalReader.annotations.highlight": "legalReader.annotations.highlight",
  "caseLaw.reader.headMatter": "caseLaw.reader.headMatter",
  "caseLaw.notesFilter.ai": "caseLaw.notesFilter.ai",
  "common.court": "common.court",
  "statutes.wordingVersionUnknown": "statutes.wordingVersionUnknown",
  "common.openInSidePanel": "common.openInSidePanel",
  "common.openInStella": "common.openInStella",
  "inspector.external.openOriginal": "inspector.external.openOriginal",
  "caseLaw.citation.notInStella": "caseLaw.citation.notInStella",
  "statutes.provisionTextUnavailable": "statutes.provisionTextUnavailable",
  "common.loading": "common.loading",
  "statutes.showCitedPartOnly": "statutes.showCitedPartOnly",
  "statutes.showFullProvision": "statutes.showFullProvision",
  "aiDisclosure.caseLaw": "aiDisclosure.caseLaw",
} as const satisfies Record<ReaderMessageKey, ReaderMessageKey>;

/** The web reader's collection attribution catalog, read from its own directory. */
export const READER_COLLECTION_KEYS = [
  "readerCollection.partialText",
  "readerCollection.unclassifiedText",
  "readerCollection.sourceAttribution",
  "readerCollection.sourceAttributionUnknownDate",
  "readerCollection.provenanceOmitted",
] as const;

export const READER_TEMPLATE_KEYS = [
  "caseLaw.viewer.textUnavailable",
  "caseLaw.reader.documentUpdated",
  "caseLaw.reader.sourceAttribution",
  "caseLaw.viewer.dissentByline",
  "statutes.provisionEffectiveFrom",
  "statutes.provisionPartTextUnavailable",
] as const;
