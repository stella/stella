import { panic } from "better-result";
import * as v from "valibot";

import { LIMITS } from "@/api/lib/limits";

/**
 * The id vocabulary the OpenAI-compatible `search`/`fetch` pair speaks.
 *
 * One reader and one writer, in one module: `search` mints every id through
 * `encodeCompatId` and `fetch` reads every id through `decodeCompatId`, so the
 * set of ids the pair can produce and the set it can resolve are the same set
 * by construction rather than by two lists agreeing.
 *
 * A bare UUID keeps meaning "matter document": ids minted before the corpus
 * reached this pair are sitting in clients' conversations and must keep
 * resolving. Corpus ids carry a kind prefix, which is also what makes the
 * vocabulary extensible without a second migration.
 */
export type CompatId =
  | { kind: "document"; entityId: string }
  | { kind: "decision"; decisionId: string }
  | { kind: "statute"; eli: string };

type CompatIdKind = CompatId["kind"];

/** The prefix each non-default kind is written with, stated once. */
const COMPAT_ID_PREFIX = {
  decision: "decision:",
  statute: "statute:",
} as const satisfies Record<Exclude<CompatIdKind, "document">, string>;

/**
 * Wire cap on a compat id: the longest member of the vocabulary is a statute,
 * whose tail is the ELI `read_statute` accepts, so the bound is that one plus
 * its prefix rather than a number chosen here.
 */
const COMPAT_ID_MAX_CHARS =
  COMPAT_ID_PREFIX.statute.length + LIMITS.legislationEliMaxChars;

/**
 * The vocabulary's grammar, written once as regular-expression source.
 *
 * The reader below tests against it and the declared input schema advertises
 * it as its `pattern`, so what a client is told is accepted and what `fetch`
 * accepts are the same grammar rather than two spellings of it. Explicit hex
 * classes and no flags: JSON Schema carries a pattern's source alone, so a
 * case-insensitive flag would be a leniency the advertised contract hides.
 */
const UUID_SOURCE =
  "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";

/** An ELI is a publisher-minted path, so any non-empty tail is a candidate. */
const STATUTE_TAIL_SOURCE = ".+";

const anchored = (...alternatives: readonly string[]): RegExp =>
  // oxlint-disable-next-line require-unicode-regexp -- @valibot/to-json-schema rejects every regex flag, and the advertised `pattern` has to be the expression this reader runs
  new RegExp(["^(?:", alternatives.join("|"), ")$"].join(""));

const DOCUMENT_ID_PATTERN = anchored(UUID_SOURCE);

const COMPAT_ID_PATTERN = anchored(
  UUID_SOURCE,
  `${COMPAT_ID_PREFIX.decision}${UUID_SOURCE}`,
  `${COMPAT_ID_PREFIX.statute}${STATUTE_TAIL_SOURCE}`,
);

const COMPAT_CORPUS_ID_PATTERN = anchored(
  `${COMPAT_ID_PREFIX.decision}${UUID_SOURCE}`,
  `${COMPAT_ID_PREFIX.statute}${STATUTE_TAIL_SOURCE}`,
);

const isUuid = (value: string): boolean => DOCUMENT_ID_PATTERN.test(value);

export const encodeCompatId = (id: CompatId): string => {
  switch (id.kind) {
    case "document":
      return id.entityId;
    case "decision":
      return `${COMPAT_ID_PREFIX.decision}${id.decisionId}`;
    case "statute":
      return `${COMPAT_ID_PREFIX.statute}${id.eli}`;
    default:
      id satisfies never;
      return panic("Unhandled compat id kind");
  }
};

/** The id a client sent, or null when it is not a member of the vocabulary. */
export const decodeCompatId = (raw: string): CompatId | null => {
  if (raw.length > COMPAT_ID_MAX_CHARS) {
    return null;
  }
  if (raw.startsWith(COMPAT_ID_PREFIX.decision)) {
    const decisionId = raw.slice(COMPAT_ID_PREFIX.decision.length);
    return isUuid(decisionId) ? { kind: "decision", decisionId } : null;
  }
  if (raw.startsWith(COMPAT_ID_PREFIX.statute)) {
    const eli = raw.slice(COMPAT_ID_PREFIX.statute.length);
    return eli.length > 0 ? { kind: "statute", eli } : null;
  }
  return isUuid(raw) ? { kind: "document", entityId: raw } : null;
};

/**
 * The vocabulary as one sentence, rendered from the prefixes above so a tool
 * description cannot promise a spelling the reader refuses. Both `search` and
 * `fetch` state it, because a model reads whichever of the two it reaches
 * first.
 */
export const COMPAT_ID_VOCABULARY =
  "An id is a bare UUID (a matter document), " +
  `\`${COMPAT_ID_PREFIX.decision}<uuid>\` (a case-law decision), or ` +
  `\`${COMPAT_ID_PREFIX.statute}<eli>\` (a statute).`;

/** The corpus half alone, for the law surface, which reaches no matter data. */
export const COMPAT_CORPUS_ID_VOCABULARY =
  `An id is \`${COMPAT_ID_PREFIX.decision}<uuid>\` (a case-law decision) or ` +
  `\`${COMPAT_ID_PREFIX.statute}<eli>\` (a statute).`;

/**
 * The one hint a malformed id answers with. It names `search` because that is
 * the call that mints a valid id; a model cannot construct one from a docket
 * number or a citation.
 */
export const COMPAT_ID_HINT = `Pass an 'id' from a search result verbatim. ${COMPAT_ID_VOCABULARY} A stella:// resource URI is read with resources/read, not this tool.`;

export const COMPAT_CORPUS_ID_HINT = `Pass an 'id' from a search result verbatim. ${COMPAT_CORPUS_ID_VOCABULARY} A stella:// resource URI is read with resources/read, not this tool.`;

/**
 * The declared `id` input. It is a string the vocabulary above admits, so a
 * value outside it fails here, as a validation issue naming the field, rather
 * than downstream as a Postgres uuid cast reported as `internal_error`.
 */
export const compatIdInputSchema = (description: string) =>
  v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(COMPAT_ID_MAX_CHARS),
    v.regex(COMPAT_ID_PATTERN, "Expected an id returned by search"),
    v.description(description),
  );

export type CompatCorpusId = Extract<
  CompatId,
  { kind: "decision" } | { kind: "statute" }
>;

/**
 * The corpus half of the vocabulary, for the audience that reaches no matter
 * data: a bare UUID is refused there rather than read as a document id that
 * audience could not fetch anyway.
 */
export const decodeCompatCorpusId = (raw: string): CompatCorpusId | null => {
  const id = decodeCompatId(raw);
  return id === null || id.kind === "document" ? null : id;
};

export const compatCorpusIdInputSchema = (description: string) =>
  v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(COMPAT_ID_MAX_CHARS),
    v.regex(COMPAT_CORPUS_ID_PATTERN, "Expected an id returned by search"),
    v.description(description),
  );
