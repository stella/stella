# Verify a case-law quotation

Call `verify_quote({ decision_id, text })` after obtaining a decision ID from
`search_case_law` or `resolve_case_law_decision`. The CLI command is
`stella case-law verify-quote --decision-id <uuid> --text '<quotation>'`.
The tool requires `stella:read` and the public-law feature.

Only `status: "exact", verified: true` confirms that the supplied text occurs.
It does not establish that a truncated quote fairly represents the decision.
`fuzzy` always has `verified: false`: report it as an altered quote, never as
confirmed. `not_found` also has `verified: false` and returns a closest passage
for inspection. `cannot_verify` identifies pending, unavailable, failed,
licence-withheld or empty text; it is never evidence that the quote is absent.
An unknown or restricted decision ID returns the standard `not_found` error
envelope rather than a quotation verdict.

Exact comparison is case-sensitive and preserves diacritics, letters and
punctuation. It normalizes Unicode whitespace (including non-breaking spaces),
curly quotation marks and guillemets, dash variants, soft hyphens, hyphenated
line endings, and spacing in `č. j.`. Literal substrings remain exact at
normalization boundaries. Double and single quotation marks remain distinct.
Ellipses `...`, `…`, `[…]` and `(...)` split the quote into ordered, nonempty
segments; each segment reports its occurrences. The tool returns all occurrences
that can participate in an ordered match, without enumerating combinations.

Each passage carries original UTF-16 `start` (inclusive) and `end` (exclusive)
offsets, its text, and the covering paragraph positions, canonical labels,
heading paths and available reader deep links. Positions count served blocks
from one; a publisher label can differ from that position. AST text takes
precedence, matching `read_case_law_decision`; otherwise stored full text is
used. Plain-text fallback paragraphs have no invented anchors.

Fuzzy comparison minimizes word/punctuation-token edit distance over a passage,
scanning each remaining document suffix in segment order. The similarity is
`1 - edits / max(quoteTokens, passageTokens)`. Scores at least `0.75` are
`fuzzy`; lower scores are `not_found`. Differences run from stored passage to
supplied quote: `dropped` words were omitted by the quote, `added` words were
inserted, and adjacent dropped/added groups express replacements. An exhausted
suffix has `closest: null`. This heuristic is not semantic verification.

Input is bounded to 4,000 characters, 128 total word/punctuation tokens and 16
segments. Comparison costs are bounded by document length times that fixed
token budget, plus returned occurrences. The tool reads one gated decision
without fetching a publisher document. Chat's bounded reader projection does
not expose this unpaginated occurrence list.

Run the deterministic calibration with
`bun --preload ./src/tests/setup-env.ts evals/verify-quote-local.ts` from
`apps/api`. It uses captured public court texts and reports scores and a large
decision benchmark. It does not measure model tool selection or interpretation.
