/**
 * What a short form may borrow from, within one scope: an opinion's body,
 * one of its notes, or one table cell.
 *
 * A scope files each full reference's entity under its reporter volume, its
 * case caption and each substantive party name, and keeps a summary of the
 * last authority clause. `Id.` borrows only from that clause; a named
 * `supra` or a `347 U.S., at 495` borrows from anything filed earlier in the
 * scope. Every lookup names exactly one entity or abstains, and inspects at
 * most a fixed number of filed entries, so a key cited under a thousand
 * times costs a lookup no more than one cited once.
 */

import { panic, Result } from "better-result";

import type { CitationUnresolvedReason } from "@stll/legal-ast/inline";

import type {
  BundleGraph,
  UsCitationBundleOverflowError,
} from "@/api/handlers/case-law/ingestion/us-citation-bundles";
import { chargeWork } from "@/api/handlers/case-law/ingestion/us-citation-scanner";
import type {
  CitationWorkBudget,
  FullToken,
  ReporterBase,
  ShortToken,
  VolumeShortToken,
} from "@/api/handlers/case-law/ingestion/us-citation-scanner";

/** Filed entries one lookup inspects before abstaining as ambiguous. */
const US_CITATION_ANTECEDENT_INSPECTION_LIMIT = 64;
/** How far before a full reference its case caption may start. */
const CAPTION_WINDOW = 200;

const BUNDLE_GAP_RE = /^\s{0,3},?\s{0,3}$/u;
const ENDS_WITH_COMMA_RE = /,\s{0,3}$/u;
const CAPTION_SEPARATOR_RE = /\s(?:v\.?|vs\.|versus)\s/gu;

// ---------------------------------------------------------------------------
// Case names

/** Words a party name may run through between capitalised words. */
const NAME_CONNECTORS = new Set([
  "of",
  "the",
  "and",
  "&",
  "for",
  "ex",
  "rel.",
  "et",
  "al.",
  "de",
  "la",
  "du",
  "von",
  "van",
  "re",
]);
/** Words that open a sentence or a citation, never a party's name. */
const LEADING_NON_NAME = new Set([
  "see",
  "cf.",
  "compare",
  "accord",
  "contra",
  "but",
  "in",
  "under",
  "unlike",
  "like",
  "as",
  "since",
  "after",
  "following",
  "per",
  "the",
  "of",
  "and",
  "for",
]);
/** Party words that alone never tell one party from another. */
const GENERIC_PARTY_WORDS = new Set([
  "state",
  "states",
  "united",
  "people",
  "in",
  "re",
  "ex",
  "parte",
  "of",
  "the",
  "and",
]);
/** Longest word, period included, read as an abbreviation inside a name. */
const NAME_ABBREVIATION_MAX_LENGTH = 5;

const normalizeName = (text: string): string =>
  text
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/ et al$/u, "");

/**
 * The party name ending exactly where `text` ends, read backwards over
 * capitalised words and name connectors, with a leading signal or
 * preposition removed. Null when nothing name-like remains.
 */
const trailingPartyName = (text: string): string | null => {
  const words = text.trimEnd().split(/\s+/u);
  const taken: string[] = [];
  for (const word of words.toReversed()) {
    const isLast = taken.length === 0;
    if (!isLast && /[,;:]$/u.test(word)) {
      break;
    }
    // A long word closed by a period ends the previous sentence.
    if (
      !isLast &&
      word.endsWith(".") &&
      word.length > NAME_ABBREVIATION_MAX_LENGTH &&
      !/\p{L}\.\p{L}/u.test(word)
    ) {
      break;
    }
    if (/^[\p{Lu}\p{N}]/u.test(word) || NAME_CONNECTORS.has(word)) {
      taken.unshift(word);
      continue;
    }
    break;
  }
  while (
    taken.length > 0 &&
    LEADING_NON_NAME.has((taken.at(0) ?? "").toLocaleLowerCase("und"))
  ) {
    taken.shift();
  }
  const name = normalizeName(taken.join(" "));
  return name === "" ? null : name;
};

type Caption = { key: string; parties: readonly [string, string] };

/**
 * A `Party v. Party` caption filling `text` up to its end, or null. The
 * second party is everything after the last separator; the first is the
 * name immediately before it.
 */
const captionOf = (text: string): Caption | null => {
  const separator = [...text.matchAll(CAPTION_SEPARATOR_RE)].at(-1);
  if (separator === undefined) {
    return null;
  }
  const second = text.slice(separator.index + separator[0].length).trim();
  if (!/^[\p{Lu}\p{N}]/u.test(second) || /[;:]|\.\s+\p{Lu}/u.test(second)) {
    return null;
  }
  const first = trailingPartyName(text.slice(0, separator.index));
  const secondName = normalizeName(second);
  if (first === null || secondName === "") {
    return null;
  }
  return {
    key: `${first} v ${secondName}`,
    parties: [first, secondName],
  };
};

const isSubstantiveParty = (party: string): boolean =>
  party.split(" ").some((word) => !GENERIC_PARTY_WORDS.has(word));

type NameEvidence =
  | { type: "caption"; key: string }
  | { type: "party"; key: string };

/** The name printed as `Name, ` right before a short form, if any. */
const nameBefore = (text: string): NameEvidence | null => {
  if (!ENDS_WITH_COMMA_RE.test(text)) {
    return null;
  }
  const name = text.replace(ENDS_WITH_COMMA_RE, "");
  const caption = captionOf(name);
  if (caption !== null) {
    return { type: "caption", key: caption.key };
  }
  const party = trailingPartyName(name);
  return party !== null && isSubstantiveParty(party)
    ? { type: "party", key: party }
    : null;
};

// ---------------------------------------------------------------------------
// Scope state

export type Resolution =
  | { type: "bundle"; bundle: number }
  | { type: "unresolved"; reason: CitationUnresolvedReason };

/** Which reporter a pin's pages belong to, read once the entity is final. */
export type PinReporterRule =
  | { type: "base"; base: ReporterBase }
  /** The entity's reporter, when it has only one. */
  | { type: "single" }
  /** The entity's reporter printed in this volume and edition. */
  | { type: "edition"; volume: string; editions: readonly string[] }
  | { type: "none" };

export type Reading = { resolution: Resolution; pinReporter: PinReporterRule };

/**
 * An authority clause, summarised: whether a barrier sits in it, and up to
 * two distinct authorities, which is all `Id.` needs to know.
 */
type Clause = {
  items: number;
  barrier: boolean;
  authorities: number[];
  crowded: boolean;
};

const emptyClause = (): Clause => ({
  items: 0,
  barrier: false,
  authorities: [],
  crowded: false,
});

export type ScopeRegistry = {
  readonly known: boolean;
  readonly captions: Map<string, Set<number>>;
  readonly parties: Map<string, Set<number>>;
  readonly volumes: Map<string, Set<number>>;
  lastClause: Clause | null;
  clause: Clause;
  /** The bundle a parallel reference may still join, and where it ended. */
  open: { bundle: number; end: number } | null;
};

/** `known` is false outside every stated opinion. */
export const createScopeRegistry = (known: boolean): ScopeRegistry => ({
  known,
  captions: new Map(),
  parties: new Map(),
  volumes: new Map(),
  lastClause: null,
  clause: emptyClause(),
  open: null,
});

export type AntecedentContext = {
  graph: BundleGraph;
  budget: CitationWorkBudget;
};

/** Where a token sits: its run's text and the end of the token before it. */
export type TokenSite = { text: string; after: number };

/** Ends the clause at a sentence or paragraph boundary; the scope keeps it as its last. */
export const closeClause = (registry: ScopeRegistry): void => {
  registry.open = null;
  if (registry.clause.items > 0) {
    registry.lastClause = registry.clause;
    registry.clause = emptyClause();
  }
};

export const recordBarrier = (registry: ScopeRegistry): void => {
  registry.open = null;
  registry.clause.items += 1;
  registry.clause.barrier = true;
};

const addAuthority = (
  { graph }: AntecedentContext,
  clause: Clause,
  bundle: number,
): void => {
  clause.items += 1;
  const at = graph.root(bundle);
  if (clause.authorities.some((earlier) => graph.root(earlier) === at)) {
    return;
  }
  if (clause.authorities.length >= 2) {
    clause.crowded = true;
    return;
  }
  clause.authorities.push(bundle);
};

const file = (
  { graph }: AntecedentContext,
  index: Map<string, Set<number>>,
  key: string,
  bundle: number,
): void => {
  const filed = index.get(key);
  const at = graph.root(bundle);
  if (filed === undefined) {
    index.set(key, new Set([at]));
  } else {
    filed.add(at);
  }
};

const volumeKey = (volume: string, edition: string): string =>
  `${volume} ${edition}`;

const unresolved = (reason: CitationUnresolvedReason): Resolution => ({
  type: "unresolved",
  reason,
});

const missing = (registry: ScopeRegistry): Resolution =>
  unresolved(registry.known ? "missing-antecedent" : "scope-unknown");

/** `incomplete` when entries were left uninspected, so `roots` may be short. */
type Candidates = { roots: Set<number>; incomplete: boolean };

/**
 * The distinct entities filed under some keys now. Stops at `enough` of them
 * or at the inspection limit; either way, entries left behind make the set
 * incomplete, and an incomplete set never proves a candidate unique.
 */
const candidatesIn = (
  { budget, graph }: AntecedentContext,
  filed: readonly Iterable<number>[],
  enough: number,
): Candidates => {
  const roots = new Set<number>();
  let inspected = 0;
  for (const entries of filed) {
    for (const entry of entries) {
      if (
        roots.size >= enough ||
        inspected >= US_CITATION_ANTECEDENT_INSPECTION_LIMIT
      ) {
        return { roots, incomplete: true };
      }
      inspected += 1;
      chargeWork(budget, 1);
      roots.add(graph.root(entry));
    }
  }
  return { roots, incomplete: false };
};

const settleOn = (
  { incomplete, roots }: Candidates,
  none: Resolution,
): Resolution => {
  if (incomplete || roots.size > 1) {
    return unresolved("ambiguous-antecedent");
  }
  const [only] = roots;
  return only === undefined ? none : { type: "bundle", bundle: only };
};

const resolveId = (
  context: AntecedentContext,
  registry: ScopeRegistry,
): Resolution => {
  const clause =
    registry.clause.items > 0 ? registry.clause : registry.lastClause;
  if (clause === null) {
    return missing(registry);
  }
  if (clause.barrier) {
    return unresolved("authority-barrier");
  }
  if (clause.crowded) {
    return unresolved("ambiguous-antecedent");
  }
  return settleOn(
    candidatesIn(context, [clause.authorities], 2),
    missing(registry),
  );
};

const nameIndex = (
  registry: ScopeRegistry,
  { key, type }: NameEvidence,
): Set<number> =>
  (type === "caption" ? registry.captions : registry.parties).get(key) ??
  new Set();

/** A bare `supra` names nothing; a named one needs one entity under its name. */
const resolveNamed = (
  context: AntecedentContext,
  registry: ScopeRegistry,
  name: NameEvidence | null,
): Resolution =>
  name === null
    ? unresolved("missing-antecedent")
    : settleOn(
        candidatesIn(context, [nameIndex(registry, name)], 2),
        missing(registry),
      );

/**
 * One entity filed under the printed volume and edition, and, when a name
 * is printed, under that name too. A printed name that matches nothing
 * abstains rather than being ignored.
 */
const resolveVolume = (
  context: AntecedentContext,
  registry: ScopeRegistry,
  token: VolumeShortToken,
  name: NameEvidence | null,
): Resolution => {
  const filed = token.editions.map(
    (edition) =>
      registry.volumes.get(volumeKey(token.volume, edition)) ??
      new Set<number>(),
  );
  if (name === null) {
    return settleOn(candidatesIn(context, filed, 2), missing(registry));
  }
  const inVolume = candidatesIn(
    context,
    filed,
    US_CITATION_ANTECEDENT_INSPECTION_LIMIT,
  );
  const named = candidatesIn(
    context,
    [nameIndex(registry, name)],
    US_CITATION_ANTECEDENT_INSPECTION_LIMIT,
  );
  // A name filed under nothing matches nothing, however long the volume.
  if (!named.incomplete && named.roots.size === 0) {
    return unresolved("missing-antecedent");
  }
  return settleOn(
    {
      roots: new Set([...inVolume.roots].filter((at) => named.roots.has(at))),
      incomplete: inVolume.incomplete || named.incomplete,
    },
    unresolved("missing-antecedent"),
  );
};

const before = ({ after, text }: TokenSite, start: number): string =>
  text.slice(Math.max(after, start - CAPTION_WINDOW), start);

/**
 * Records a full reference: a parallel of the open bundle when only a comma
 * separates them and its reporter is not already there, otherwise a bundle
 * of its own under the caption printed right before it.
 */
export const recordFull = (
  context: AntecedentContext,
  registry: ScopeRegistry,
  token: FullToken,
  site: TokenSite,
): Result<Reading, UsCitationBundleOverflowError> => {
  const { graph } = context;
  const { base } = token;
  if (base === null) {
    recordBarrier(registry);
    return Result.ok({
      resolution: unresolved("ambiguous-reporter"),
      pinReporter: { type: "none" },
    });
  }
  const pinReporter: PinReporterRule = { type: "base", base };
  const { open } = registry;
  if (
    open !== null &&
    !graph.hasFamily(open.bundle, base.family) &&
    BUNDLE_GAP_RE.test(site.text.slice(open.end, token.start))
  ) {
    const joined = graph.join(open.bundle, base);
    if (Result.isError(joined)) {
      return Result.err(joined.error);
    }
    open.end = token.end;
    file(
      context,
      registry.volumes,
      volumeKey(base.volume, base.edition),
      open.bundle,
    );
    return Result.ok({
      resolution: { type: "bundle", bundle: open.bundle },
      pinReporter,
    });
  }
  const printed = before(site, token.start);
  const caption = ENDS_WITH_COMMA_RE.test(printed)
    ? captionOf(printed.replace(ENDS_WITH_COMMA_RE, ""))
    : null;
  const opened = graph.open(base, caption?.key ?? null);
  if (Result.isError(opened)) {
    return Result.err(opened.error);
  }
  const bundle = opened.value;
  file(context, registry.volumes, volumeKey(base.volume, base.edition), bundle);
  if (caption !== null) {
    file(context, registry.captions, caption.key, bundle);
    for (const party of new Set(caption.parties)) {
      if (isSubstantiveParty(party)) {
        file(context, registry.parties, party, bundle);
      }
    }
  }
  addAuthority(context, registry.clause, bundle);
  registry.open = { bundle, end: token.end };
  return Result.ok({ resolution: { type: "bundle", bundle }, pinReporter });
};

const readShort = (
  context: AntecedentContext,
  registry: ScopeRegistry,
  token: ShortToken | VolumeShortToken,
  printed: string,
): Reading => {
  switch (token.kind) {
    case "id":
      return {
        resolution: resolveId(context, registry),
        pinReporter: { type: "single" },
      };
    case "supra":
      return {
        resolution: resolveNamed(context, registry, nameBefore(printed)),
        pinReporter: { type: "single" },
      };
    case "volume-reporter":
      return {
        resolution: resolveVolume(
          context,
          registry,
          token,
          nameBefore(printed),
        ),
        pinReporter: {
          type: "edition",
          volume: token.volume,
          editions: token.editions,
        },
      };
    default: {
      token satisfies never;
      return panic("Unhandled short form");
    }
  }
};

/**
 * Resolves a short form and records it in the clause: an identified one as
 * its authority, an unresolved one as a barrier no later `Id.` reads past.
 */
export const resolveShort = (
  context: AntecedentContext,
  registry: ScopeRegistry,
  token: ShortToken | VolumeShortToken,
  site: TokenSite,
): Reading => {
  registry.open = null;
  const reading = readShort(
    context,
    registry,
    token,
    before(site, token.start),
  );
  if (reading.resolution.type === "bundle") {
    addAuthority(context, registry.clause, reading.resolution.bundle);
  } else {
    recordBarrier(registry);
  }
  return reading;
};
