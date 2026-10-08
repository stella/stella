import type { ReaderMessageKey } from "@stll/decision-reader/reader-message-types";

export const READER_MESSAGE_KEYS = {
  "statutes.diffRemoved": "statutes.diffRemoved",
  "statutes.diffInserted": "statutes.diffInserted",
  "common.copyLink": "common.copyLink",
  "common.back": "common.back",
  "caseLaw.viewer.legalSentence": "caseLaw.viewer.legalSentence",
  "caseLaw.viewer.abstract": "caseLaw.viewer.abstract",
  "folio.comment": "folio.comment",
  "legalReader.annotations.highlight": "legalReader.annotations.highlight",
  "caseLaw.reader.headMatter": "caseLaw.reader.headMatter",
  "caseLaw.notesFilter.ai": "caseLaw.notesFilter.ai",
  "common.court": "common.court",
  "statutes.currentWording": "statutes.currentWording",
  "statutes.wordingVersionUnknown": "statutes.wordingVersionUnknown",
  "statutes.openProvision": "statutes.openProvision",
} as const satisfies Record<ReaderMessageKey, ReaderMessageKey>;

export const READER_TEMPLATE_KEYS = [
  "caseLaw.viewer.textUnavailable",
  "caseLaw.reader.sourceAttribution",
  "caseLaw.viewer.dissentByline",
  "statutes.wordingValidFrom",
] as const;
