// parser-output-unchanged: a new module; only the pl-ncourt parser reads it, and that parser's version is bumped.
/**
 * The check a common-court `xLexLink` passes before it becomes a link.
 *
 * The portal's editor derives `xArt` and `xIsapId` from the words it links,
 * and it gets them wrong: a paragraph of a regulation tagged as a code's
 * article, an index flattened into a second article, a missing article. The
 * attributes are therefore claims about the anchor, never facts. A claim
 * survives only when every provision it names is printed in the anchor.
 */

/** Why a link, or the provision it claims, was not kept. */
export const LEXLINK_REJECTION = {
  /** The anchor names another kind of act (a regulation) than the tagged one. */
  FOREIGN_ACT: "foreign-act",
  /** The anchor is a bare paragraph or point; it cannot establish which act. */
  BARE_PROVISION: "bare-provision",
  /** `xArt` names provisions the anchor does not print. */
  PROVISION_NOT_IN_ANCHOR: "provision-not-in-anchor",
} as const;

export type LexLinkRejection =
  (typeof LEXLINK_REJECTION)[keyof typeof LEXLINK_REJECTION];

export type LexLinkVerdict =
  | { type: "provision" }
  | {
      type: "act";
      /** Set when the link's `xArt` was dropped; absent when it was empty. */
      dropped: typeof LEXLINK_REJECTION.PROVISION_NOT_IN_ANCHOR | undefined;
    }
  | { type: "rejected"; reason: LexLinkRejection };

type LexLinkClaim = {
  /** The words the judgment links, superscripts and subscripts as `(n)`. */
  anchor: string;
  /** `xArt`, `;`-separated as printed. */
  articles: string;
  /** `xTitle`: the tagged act's title. */
  title: string;
};

/** A provision's levels, as a token the anchor and the claim can share. */
const PROVISION_KINDS = new Map([
  ["art", "art"],
  ["§", "par"],
  ["ust", "ust"],
  ["pkt", "pkt"],
  ["lit", "lit"],
]);

const NUMBER_SOURCE = String.raw`\d+[a-z]?(?:\(\d+\))?`;
const LIST_JOINER_SOURCE = String.raw`\s*(?:,|-|–|\bi\b|\boraz\b|\bdo\b)\s*`;
const TOKEN_PATTERN = new RegExp(
  String.raw`(?<!\p{L})(art|§|ust|pkt|lit)\.?\s*(${NUMBER_SOURCE}(?:${LIST_JOINER_SOURCE}${NUMBER_SOURCE})*)`,
  "giu",
);
const NUMBER_PATTERN = new RegExp(NUMBER_SOURCE, "gu");

/** Names a regulation, directive, convention or treaty in any case. */
const FOREIGN_ACT_PATTERN =
  /(?<![\p{L}])(rozporz[aą]dz|dyrektyw|konwencj|traktat)\p{L}*/giu;

/** Collapses whitespace and attaches an index to its number: `505 (8)`. */
const normalised = (text: string): string =>
  text.replaceAll(/\s+/gu, " ").replaceAll(/ \(/gu, "(").trim().toLowerCase();

type ProvisionTokens = {
  /** `kind:number` for every level named. */
  tokens: Set<string>;
  /** Text left once every provision token is removed. */
  remainder: string;
};

const tokensOf = (text: string): ProvisionTokens => {
  const tokens = new Set<string>();
  const remainder = normalised(text).replaceAll(
    TOKEN_PATTERN,
    (match, word: string, numbers: string) => {
      const kind = PROVISION_KINDS.get(word);
      if (kind === undefined) {
        return match;
      }
      for (const number of numbers.match(NUMBER_PATTERN) ?? []) {
        tokens.add(`${kind}:${number}`);
      }
      return "";
    },
  );
  return { tokens, remainder: remainder.replaceAll(/\s+/gu, "") };
};

const hasArticle = (tokens: Set<string>): boolean =>
  [...tokens].some((token) => token.startsWith("art:"));

/** Every provision a claim names is printed in the anchor. */
const claimFollowsAnchor = (
  anchor: ProvisionTokens,
  claim: string,
): boolean => {
  const entries = claim
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return entries.every((entry) => {
    const named = tokensOf(entry);
    return (
      hasArticle(named.tokens) &&
      named.remainder.length === 0 &&
      [...named.tokens].every((token) => anchor.tokens.has(token))
    );
  });
};

const namesForeignAct = ({ anchor, title }: LexLinkClaim): boolean => {
  const tagged = title.toLowerCase();
  return [...anchor.matchAll(FOREIGN_ACT_PATTERN)].some(
    ([, stem]) => stem !== undefined && !tagged.includes(stem.toLowerCase()),
  );
};

/**
 * Whether a statute link may stand: `provision` (the claim follows the anchor),
 * `act` (the act link stands; the claim is empty, or was dropped for the
 * reason it carries) or `rejected` (the anchor is plain text).
 */
export const judgeLexLink = (link: LexLinkClaim): LexLinkVerdict => {
  if (namesForeignAct(link)) {
    return { type: "rejected", reason: LEXLINK_REJECTION.FOREIGN_ACT };
  }
  const anchor = tokensOf(link.anchor);
  const claimed = link.articles.trim().length > 0;
  if (anchor.tokens.size > 0 && !hasArticle(anchor.tokens)) {
    return { type: "rejected", reason: LEXLINK_REJECTION.BARE_PROVISION };
  }
  if (!claimed) {
    return { type: "act", dropped: undefined };
  }
  return claimFollowsAnchor(anchor, link.articles)
    ? { type: "provision" }
    : { type: "act", dropped: LEXLINK_REJECTION.PROVISION_NOT_IN_ANCHOR };
};
