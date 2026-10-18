import { isPublicCountry } from "./public-country-capability";
import type { PublicCountry } from "./public-country-capability";

/**
 * A public corpus the reader can put in front of a chat turn as a chip
 * ("@Case law · Czechia"). The chip scopes that turn's corpus tools to the
 * corpus and country it names; the server enforces it, the prompt does not.
 */
export const CHAT_CORPORA = ["case_law", "legislation"] as const;

export type ChatCorpus = (typeof CHAT_CORPORA)[number];

export type ChatCorpusScope = {
  corpus: ChatCorpus;
  country: PublicCountry;
};

const isChatCorpus = (value: string): value is ChatCorpus =>
  CHAT_CORPORA.some((corpus) => corpus === value);

const CORPUS_ID_SEPARATOR = ":";

/** The chip's id: `case_law:CZE`. One spelling, so a chip round-trips. */
export const formatChatCorpusId = ({ corpus, country }: ChatCorpusScope) =>
  `${corpus}${CORPUS_ID_SEPARATOR}${country}`;

/** The link a corpus chip persists as: `#stella-corpus=case_law:CZE`. */
export const CHAT_CORPUS_HREF_PREFIX = "#stella-corpus=";

export const toChatCorpusHref = (scope: ChatCorpusScope) =>
  `${CHAT_CORPUS_HREF_PREFIX}${formatChatCorpusId(scope)}`;

/** A persisted corpus link back into its scope; null for any other href. */
export const parseChatCorpusHref = (href: string): ChatCorpusScope | null =>
  href.startsWith(CHAT_CORPUS_HREF_PREFIX)
    ? parseChatCorpusId(href.slice(CHAT_CORPUS_HREF_PREFIX.length))
    : null;

/** A chip id back into its scope, or null for anything that is not one. */
export const parseChatCorpusId = (id: string): ChatCorpusScope | null => {
  const [corpus, country, ...rest] = id.split(CORPUS_ID_SEPARATOR);
  if (
    corpus === undefined ||
    country === undefined ||
    rest.length > 0 ||
    !isChatCorpus(corpus) ||
    !isPublicCountry(country)
  ) {
    return null;
  }
  return { corpus, country };
};
