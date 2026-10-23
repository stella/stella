import type { AiDisclosureMessageKey } from "@stll/api-contract/ai-disclosure";

export type ReaderMessageKey =
  | "statutes.diffRemoved"
  | "statutes.diffInserted"
  | "common.copyLink"
  | "common.copied"
  | "common.back"
  | "caseLaw.viewer.legalSentence"
  | "caseLaw.viewer.abstract"
  | "folio.comment"
  | "legalReader.annotations.highlight"
  | "caseLaw.reader.headMatter"
  | "caseLaw.notesFilter.ai"
  | "common.court"
  | "statutes.wordingVersionUnknown"
  | "statutes.openProvision"
  | "statutes.provisionTextUnavailable"
  | "statutes.showCitedPartOnly"
  | "statutes.showFullProvision"
  // Every disclosure context, so a context added to the contract cannot ship
  // until each host that renders the reader carries its sentence.
  | AiDisclosureMessageKey;
