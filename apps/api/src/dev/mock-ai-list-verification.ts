// The mock model's answers to the two list verification passes
// (apps/api/src/lib/lists/verification/claim-extract.ts and claim-grade.ts).
// Both answer from the request rather than from a fixed fixture: extraction
// keeps only quotes it finds in the named block, and grading answers by the
// claim ids the request lists, so a canned answer would ground nothing.
//
// Grading is a word-overlap heuristic, deterministic for one request, that
// lands on the verdicts and qualifiers a local run needs to show. A claim
// about the author's own state of mind has no coverage and the record is
// silent on it; one sharing too little with every fact has no coverage.
// Otherwise it rests on the fact it shares most with: a claim that stretches
// over a whole period is in tension with a scope mismatch, a denial is
// contradicted, a hedged figure is in tension, and the rest are supported.

const SENTENCES_PER_BLOCK = 2;
const CLAIM_QUOTE_MAX = 400;
/** Overlap a claim needs with a fact to be covered by it: a name counts
 *  twice, any other shared word once. */
const COVERAGE_MIN = 2;
/** A word on more facts than this (the author's own name) tells none of
 *  them apart. */
const DISTINCTIVE_FACTS_MAX = 3;

/** What the extraction prompt says to skip: identity, procedure, statements
 *  of truth and signatures. */
const NOT_A_CLAIM =
  /^(?:I, [^,]+, am\b|I make this statement|Statement of truth|Signed\b)/u;
const OPINION = /\b(?:I (?:believe|consider|think)|in my view)\b/iu;
const RECALLED =
  /\b(?:I recall|I remember|to my knowledge|to the best of my)\b/iu;
/** The author's own state of mind or characterisation: no record speaks
 *  to it. */
const OWN_STATE =
  /\b(?:I (?:would have expected|understood|do not accept|felt|acted on|should be clear)|in good faith|carefully|unremarkable|professional in nature)\b/iu;
/** A claim that stretches over a whole period. */
const WHOLE_PERIOD = /\b(?:whole of|entire|throughout|all of)\b/iu;
const DENIAL = /\b(?:no|never|not|did not|had no)\b/iu;
const HEDGED = /\b(?:approximately|about|around|roughly)\b/iu;

const STOP_WORDS = new Set([
  "about",
  "account",
  "after",
  "before",
  "from",
  "have",
  "that",
  "their",
  "there",
  "this",
  "were",
  "what",
  "when",
  "which",
  "with",
  "would",
]);

const TOKEN = /[\p{L}\p{N}][\p{L}\p{N},.]*[\p{L}\p{N}]/gu;

const tokens = (text: string): string[] =>
  (text.match(TOKEN) ?? [])
    .map((token) => token.replaceAll(",", ""))
    .filter(
      (token) => token.length >= 4 && !STOP_WORDS.has(token.toLowerCase()),
    );

const words = (text: string): Set<string> =>
  new Set(tokens(text).map((token) => token.toLowerCase()));

const sentencesOf = (text: string): string[] =>
  text
    // A paragraph number is not a sentence of its own.
    .replace(/^\s*\d+\.\s+/u, "")
    .split(/(?<=[.!?])\s+/u)
    .map((sentence) => sentence.trim())
    .filter(
      (sentence) => /[.!?]$/u.test(sentence) && !NOT_A_CLAIM.test(sentence),
    );

/** `[id] text` lines of the blocks a request carries. */
const requestBlocks = (request: string): Map<string, string> => {
  const blocks = new Map<string, string>();
  for (const line of request.split("\n")) {
    const block = /^\[(?<id>[^\]]+)\] (?<text>.+)$/u.exec(line)?.groups;
    if (block?.["id"] !== undefined && block["text"] !== undefined) {
      blocks.set(block["id"], block["text"]);
    }
  }
  return blocks;
};

export const mockExtractedClaims = (request: string) => {
  const asked =
    /List the claims in these blocks only: (?<ids>.+)$/mu
      .exec(request)
      ?.groups?.["ids"]?.split(", ") ?? [];
  const blocks = requestBlocks(request);
  return asked.flatMap((blockId) =>
    sentencesOf(blocks.get(blockId) ?? "")
      .slice(0, SENTENCES_PER_BLOCK)
      .map((sentence) => {
        const quote = sentence.slice(0, CLAIM_QUOTE_MAX);
        return {
          blockId,
          quote,
          type: OPINION.test(quote) ? "opinion" : "fact",
          framing: RECALLED.test(quote) ? "recalled" : "asserted",
        };
      }),
  );
};

/** `- <id>: <text>` lines of one prefix (`F` facts, `C` claims), each with
 *  the indented detail line under it (a fact's date, kind and medium). */
const promptItems = (request: string, prefix: "F" | "C") =>
  [
    ...request.matchAll(
      new RegExp(`^- (${prefix}\\d+): (.+)$(?:\\n {2}(.+)$)?`, "gmu"),
    ),
  ].map(([, id = "", text = "", detail = ""]) => ({ id, text, detail }));

const RECORD_SILENT_EXPLANATION =
  "This is the author's own account of their understanding; no document in the record would be expected to address it.";
const SCOPE_MISMATCH_EXPLANATION =
  "The fact covers only part of the period the claim speaks to, so it does not settle the claim as worded.";

export const mockClaimGrades = (request: string) => {
  const facts = promptItems(request, "F").map((fact) => ({
    id: fact.id,
    words: words(`${fact.text} ${fact.detail}`),
  }));
  const factsWith = (word: string) =>
    facts.filter((fact) => fact.words.has(word)).length;
  return promptItems(request, "C").map((claim) => {
    // A word capitalised after the sentence start is taken for a name.
    const weights = new Map(
      tokens(claim.text).map((token, index) => [
        token.toLowerCase(),
        index > 0 && /^\p{Lu}/u.test(token) ? 2 : 1,
      ]),
    );
    const ranked = facts
      .map((fact) => ({
        id: fact.id,
        overlap: [...weights]
          .filter(
            ([word]) =>
              fact.words.has(word) && factsWith(word) <= DISTINCTIVE_FACTS_MAX,
          )
          .reduce((sum, [, weight]) => sum + weight, 0),
      }))
      .filter(({ overlap }) => overlap >= COVERAGE_MIN)
      .toSorted((a, b) => b.overlap - a.overlap);
    const best = ranked.at(0);
    const silent = OWN_STATE.test(claim.text);
    if (best === undefined || silent) {
      return {
        claimId: claim.id,
        verdict: "nocover",
        score: null,
        refs: [],
        conflict: null,
        qualifiers: silent
          ? [{ kind: "record-silent", explanation: RECORD_SILENT_EXPLANATION }]
          : [],
      };
    }
    if (WHOLE_PERIOD.test(claim.text)) {
      return {
        claimId: claim.id,
        verdict: "tension",
        score: 48,
        refs: [{ factId: best.id, rel: "conflicts" }],
        conflict: null,
        qualifiers: [
          { kind: "scope-mismatch", explanation: SCOPE_MISMATCH_EXPLANATION },
        ],
      };
    }
    if (DENIAL.test(claim.text)) {
      return {
        claimId: claim.id,
        verdict: "contradicted",
        score: 12,
        refs: [{ factId: best.id, rel: "conflicts" }],
        conflict: null,
        qualifiers: [],
      };
    }
    const hedged = HEDGED.test(claim.text);
    return {
      claimId: claim.id,
      verdict: hedged ? "tension" : "supported",
      score: hedged ? 61 : 88,
      refs: [{ factId: best.id, rel: "supports" }],
      conflict: null,
      qualifiers: [],
    };
  });
};
