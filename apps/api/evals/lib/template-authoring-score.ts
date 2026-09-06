/**
 * Deterministic scoring for the `save_template` authoring eval
 * (`evals/template-authoring.ts`). Kept in its own module because the eval
 * script runs a paid model turn at import time: the scoring has to be
 * importable, and unit-testable, without that.
 *
 * Everything here is pure. The eval feeds in what the model produced (the
 * marked-up document blocks, the `fields` overlay it passed, the paths the
 * real discovery found) plus the outcome of the real fill round trip, and
 * gets back a run score whose every field is a count or a named code.
 */

import {
  assertNever,
  detectRowBlockPair,
  isBlockDirectiveKind,
  scanInvalidMarkers,
  scanMarkers,
} from "@stll/template-conditions";

/**
 * One block of the document the model authored. A table cell holds a
 * paragraph, so `block_marker_inline` is decided per cell exactly as it is per
 * body paragraph — except for the row block a row's cells may declare between
 * them, which is a supported placement (see {@link detectRowBlockPair}).
 */
export type AuthoredBlock =
  | { type: "paragraph"; text: string }
  | { type: "table"; rows: readonly (readonly string[])[] };

/** The subset of a `fields` overlay entry the trap detectors read. Every
 *  `FieldMeta` satisfies it structurally, so the eval passes its real
 *  overlay and a test can pass a literal. */
type OverlayFieldView = {
  path: string;
  condition?: string | undefined;
  lookup?: { formats?: readonly { key: string }[] | undefined } | undefined;
};

/**
 * Grammar mistakes an agent authoring a stella template actually makes. Each
 * code names one confusion, so a report says which rule the reference
 * resources failed to teach rather than "the template was wrong".
 */
export const GRAMMAR_TRAP_CODES = [
  /** `{{name}}` inside `{{#each attorneys}}` instead of `{{attorneys.name}}`. */
  "unprefixed_item_path",
  /** `{{this.name}}` / `{{this}}`: a Handlebars reflex stella does not have. */
  "this_prefix",
  /** A directive-shaped marker that classifies to nothing (`{{#endeach}}`). */
  "unknown_directive",
  /** `{{attorneys[0].name}}` instead of the numeric segment `attorneys.0.name`. */
  "bracket_index",
  /** One value given a per-language path (`date_pl` beside `date_en`). */
  "language_variant_path",
  /** A block directive sharing its paragraph with text or another directive. */
  "block_marker_inline",
  /** A lookup declared per leaf (`company.krs`) instead of one parent with formats. */
  "lookup_not_parent",
  /** A `condition` on a field the person answers as a yes/no question. */
  "condition_on_input",
] as const;

type GrammarTrapCode = (typeof GRAMMAR_TRAP_CODES)[number];

/** Total over {@link GRAMMAR_TRAP_CODES}: a new code has no default. */
export type GrammarTrapCounts = Record<GrammarTrapCode, number>;

const zeroTrapCounts = (): GrammarTrapCounts => ({
  unprefixed_item_path: 0,
  this_prefix: 0,
  unknown_directive: 0,
  bracket_index: 0,
  language_variant_path: 0,
  block_marker_inline: 0,
  lookup_not_parent: 0,
  condition_on_input: 0,
});

/**
 * One paragraph as the trap detectors read it. `rowBlockStarts` holds the
 * offsets of the block markers that open or close a ROW block — a pair that
 * prefixes one cell of a table row and suffixes another — which is a supported
 * placement, not a marker crowded into a paragraph.
 */
type ScannedParagraph = {
  text: string;
  rowBlockStarts: ReadonlySet<number>;
};

const NO_ROW_BLOCK: ReadonlySet<number> = new Set<number>();

/**
 * One table row's paragraphs, with the row block its cells declare (if any)
 * marked. Cells are split on newlines because a newline inside a cell starts a
 * new paragraph, exactly as it does in the body.
 */
const rowParagraphs = (row: readonly string[]): ScannedParagraph[] => {
  const cells = row.map((cell) => cell.split("\n"));
  const pair = detectRowBlockPair(cells);
  const startsAt = (cellIndex: number, paragraphIndex: number): number[] =>
    pair === null
      ? []
      : [pair.open, pair.close]
          .filter(
            (end) =>
              end.cellIndex === cellIndex &&
              end.paragraphIndex === paragraphIndex,
          )
          .map(({ marker }) => marker.start);

  return cells.flatMap((paragraphs, cellIndex) =>
    paragraphs.map((text, paragraphIndex) => {
      const starts = startsAt(cellIndex, paragraphIndex);
      return {
        text,
        rowBlockStarts: starts.length === 0 ? NO_ROW_BLOCK : new Set(starts),
      };
    }),
  );
};

/** Every paragraph in document order, which the `{{#each}}` nesting walk
 *  depends on. */
const paragraphsOf = (blocks: readonly AuthoredBlock[]): ScannedParagraph[] =>
  blocks.flatMap((block) =>
    block.type === "paragraph"
      ? [{ text: block.text, rowBlockStarts: NO_ROW_BLOCK }]
      : block.rows.flatMap(rowParagraphs),
  );

const DIRECTIVE_SHAPED_RE = /^[#/@]/u;

/** Two-letter tags a bilingual document is likely to suffix a path with.
 *  Deliberately short: a longer list starts eating real field names. */
const LANGUAGE_TAGS = new Set([
  "ar",
  "cs",
  "de",
  "en",
  "es",
  "fr",
  "it",
  "pl",
  "sk",
]);

/**
 * Drop a language affix from a path's last segment (`price_pl`, `pl_price`,
 * `price.pl`), so two per-language spellings of one value collapse to the
 * same key. Returns the path unchanged when no affix is present.
 */
const stripLanguageAffix = (path: string): string => {
  const segments = path.toLowerCase().split(".");
  const last = segments.at(-1) ?? "";
  const head = segments.slice(0, -1);
  if (head.length > 0 && LANGUAGE_TAGS.has(last)) {
    return head.join(".");
  }
  const suffix = /^(?<base>.+)_(?<tag>\p{Ll}{2})$/u.exec(last);
  const suffixTag = suffix?.groups?.["tag"];
  const suffixBase = suffix?.groups?.["base"];
  if (
    suffixTag !== undefined &&
    suffixBase !== undefined &&
    LANGUAGE_TAGS.has(suffixTag)
  ) {
    return [...head, suffixBase].join(".");
  }
  const prefix = /^(?<tag>\p{Ll}{2})_(?<base>.+)$/u.exec(last);
  const prefixTag = prefix?.groups?.["tag"];
  const prefixBase = prefix?.groups?.["base"];
  if (
    prefixTag !== undefined &&
    prefixBase !== undefined &&
    LANGUAGE_TAGS.has(prefixTag)
  ) {
    return [...head, prefixBase].join(".");
  }
  return segments.join(".");
};

/** Paths that collapse onto one key once their language affix is dropped:
 *  every member past the first is one duplicated value. */
const countLanguageVariants = (paths: readonly string[]): number => {
  const groups = new Map<string, Set<string>>();
  for (const path of paths) {
    const key = stripLanguageAffix(path);
    const group = groups.get(key) ?? new Set<string>();
    group.add(path);
    groups.set(key, group);
  }
  let count = 0;
  for (const group of groups.values()) {
    count += group.size - 1;
  }
  return count;
};

const rootSegment = (path: string): string => path.split(".")[0] ?? path;

/** A truthiness test on the field's own path (`penalty`, `penalty == true`),
 *  which is the tick-box confusion wherever it appears. */
const TRUTHINESS_TAIL_RE = /\s*(?:==|=|is)\s*true$/u;

const isSelfReferentialCondition = (path: string, condition: string): boolean =>
  condition.trim().toLowerCase().replace(TRUTHINESS_TAIL_RE, "").trim() ===
  path.toLowerCase();

type DetectGrammarTrapsOptions = {
  /** The document the model authored, in order. */
  blocks: readonly AuthoredBlock[];
  /** The `fields` overlay it passed to `save_template`. */
  overlay: readonly OverlayFieldView[];
  /** Paths the task expects a person to answer as a yes/no question, so a
   *  `condition` on one of them is the tick-box confusion. */
  booleanInputPaths: readonly string[];
};

/**
 * Count each named grammar trap in one authored document + overlay pair.
 * Counts are occurrences, not booleans, so a model that repeats a mistake in
 * every paragraph is distinguishable from one that slipped once.
 */
export const detectGrammarTraps = ({
  blocks,
  overlay,
  booleanInputPaths,
}: DetectGrammarTrapsOptions): GrammarTrapCounts => {
  const counts = zeroTrapCounts();
  const eachStack: string[] = [];
  const placeholderPaths: string[] = [];
  const arrayPaths = new Set<string>();

  for (const { rowBlockStarts, text } of paragraphsOf(blocks)) {
    for (const invalid of scanInvalidMarkers(text)) {
      if (DIRECTIVE_SHAPED_RE.test(invalid.inner)) {
        counts.unknown_directive += 1;
      }
      if (invalid.inner.includes("[")) {
        counts.bracket_index += 1;
      }
    }

    const markers = scanMarkers(text);
    // A row block's two markers are placed as the grammar allows: the opener
    // in front of one cell's text, the closer behind another's. Only markers
    // that genuinely share a paragraph with other content are the trap.
    const blockMarkers = markers.filter(
      (marker) =>
        isBlockDirectiveKind(marker.meta.kind) &&
        !rowBlockStarts.has(marker.start),
    );
    if (blockMarkers.length > 0) {
      let remainder = text;
      for (const marker of blockMarkers.toReversed()) {
        remainder =
          remainder.slice(0, marker.start) + remainder.slice(marker.end);
      }
      // Two block directives in one paragraph (`{{#if x}}{{/if}}`) leave an
      // empty remainder, yet neither occupies a paragraph of its own.
      if (remainder.trim() !== "" || blockMarkers.length > 1) {
        counts.block_marker_inline += 1;
      }
    }

    for (const { meta } of markers) {
      if (meta.kind === "each") {
        arrayPaths.add(meta.expr);
        eachStack.push(meta.expr);
        continue;
      }
      if (meta.kind === "endeach") {
        eachStack.pop();
        continue;
      }
      if (meta.kind !== "placeholder") {
        continue;
      }
      const { expr } = meta;
      placeholderPaths.push(expr);
      if (expr === "this" || expr.startsWith("this.")) {
        counts.this_prefix += 1;
        continue;
      }
      const enclosing = eachStack.at(-1);
      if (
        enclosing !== undefined &&
        expr !== enclosing &&
        !expr.startsWith(`${enclosing}.`)
      ) {
        counts.unprefixed_item_path += 1;
      }
    }
  }

  counts.language_variant_path = countLanguageVariants([
    ...new Set(placeholderPaths),
  ]);

  const markerPathSet = new Set(placeholderPaths);
  const booleanInputs = new Set(booleanInputPaths);
  for (const field of overlay) {
    if (
      field.lookup !== undefined &&
      field.path.includes(".") &&
      markerPathSet.has(rootSegment(field.path)) &&
      !arrayPaths.has(rootSegment(field.path))
    ) {
      counts.lookup_not_parent += 1;
    }
    const { condition } = field;
    if (
      condition !== undefined &&
      (booleanInputs.has(field.path) ||
        isSelfReferentialCondition(field.path, condition))
    ) {
      counts.condition_on_input += 1;
    }
  }

  return counts;
};

/** Whitespace differences are formatting, not lost wording. */
const normalizeWording = (text: string): string =>
  text.replaceAll(/\s+/gu, " ").trim();

/**
 * Source wording the authored template failed to carry over. Markers replace
 * the values a template makes fillable; everything else, headings and clauses
 * included, has to survive, or a model could earn a pass by emitting a
 * skeleton of bare markers.
 */
export const checkSourceFidelity = ({
  authored,
  preservedPhrases,
}: {
  /** Every paragraph of the authored document, cells included. */
  authored: readonly string[];
  /** Source wording that no marker replaces, so it must appear verbatim. */
  preservedPhrases: readonly string[];
}): string[] => {
  const text = normalizeWording(authored.join("\n"));
  return preservedPhrases
    .filter((phrase) => !text.includes(normalizeWording(phrase)))
    .map((phrase) => `dropped "${phrase}"`);
};

type PathComparison = {
  missing: string[];
  extra: string[];
};

/** Discovered field paths against the set the task's brief names. */
export const comparePaths = (
  expected: readonly string[],
  actual: readonly string[],
): PathComparison => {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  return {
    missing: expected.filter((path) => !actualSet.has(path)),
    extra: [...actualSet].filter((path) => !expectedSet.has(path)).sort(),
  };
};

/** What the real fill made of the saved template, with fixed values. */
export type RoundTripDefects = {
  /** A literal `{{` left in the rendered text. */
  leftoverMarkers: number;
  /** Repeated units that did not render exactly once with all their values:
   *  missing, blank, or duplicated. */
  blankRepeatedRows: number;
  /** A `{{#if}}` block whose flag is false whose content is still present. */
  conditionalRowKept: boolean;
  /** A date field rendered outside the locale and style it asked for. */
  dateLocaleMismatch: boolean;
};

export const cleanRoundTrip = (): RoundTripDefects => ({
  leftoverMarkers: 0,
  blankRepeatedRows: 0,
  conditionalRowKept: false,
  dateLocaleMismatch: false,
});

const hasRoundTripDefect = (roundTrip: RoundTripDefects): boolean =>
  roundTrip.leftoverMarkers > 0 ||
  roundTrip.blankRepeatedRows > 0 ||
  roundTrip.conditionalRowKept ||
  roundTrip.dateLocaleMismatch;

/**
 * What became of the model's last `save_template` call. `rejected` covers the
 * production validations that refuse a call outright (schema, mutually
 * exclusive derived sources, a `path` matching no marker); `invalid-docx`
 * covers bytes that are not a DOCX at all.
 */
export type SaveAttempt =
  | { status: "invalid-docx"; reason: string }
  | { status: "rejected"; overlayIssues: readonly string[] }
  | {
      status: "unsaved";
      paths: PathComparison;
      traps: GrammarTrapCounts;
      overlayIssues: readonly string[];
      fidelity: readonly string[];
    }
  | {
      status: "saved";
      paths: PathComparison;
      traps: GrammarTrapCounts;
      overlayIssues: readonly string[];
      configDefects: readonly string[];
      /** Source wording the template dropped: marking values fillable must
       *  not licence rewriting or deleting the rest of the document. */
      fidelity: readonly string[];
      roundTrip: RoundTripDefects;
    };

type AuthoringOutcome =
  | "pass"
  | "partial"
  | "invalid-docx"
  | "no-call"
  | "error";

export type AuthoringRunScore = {
  outcome: AuthoringOutcome;
  paths: PathComparison;
  traps: GrammarTrapCounts;
  overlayIssues: readonly string[];
  configDefects: readonly string[];
  fidelity: readonly string[];
  roundTrip: RoundTripDefects;
  /** Why the run is not a `pass`, when the reason is not a defect list. */
  note: string | null;
};

type ScoreAuthoringRunOptions = {
  /** The provider's error, when the turn itself failed. */
  turnError: string | null;
  /** The last `save_template` attempt, or null when the model never called it. */
  attempt: SaveAttempt | null;
};

const emptyScore = (): Omit<AuthoringRunScore, "outcome" | "note"> => ({
  paths: { missing: [], extra: [] },
  traps: zeroTrapCounts(),
  overlayIssues: [],
  configDefects: [],
  fidelity: [],
  roundTrip: cleanRoundTrip(),
});

/**
 * Fold one attempt into an outcome plus its defect lists. A `pass` is a template
 * that discovered exactly the expected paths, tripped no grammar trap, passed
 * every production validation, configured every field the brief asked for,
 * and filled cleanly.
 */
const scoreAttempt = (attempt: SaveAttempt | null): AuthoringRunScore => {
  if (attempt === null) {
    return {
      ...emptyScore(),
      outcome: "no-call",
      note: "no save_template call",
    };
  }
  switch (attempt.status) {
    case "invalid-docx":
      return {
        ...emptyScore(),
        outcome: "invalid-docx",
        note: attempt.reason,
      };
    case "rejected":
      return {
        ...emptyScore(),
        outcome: "partial",
        overlayIssues: attempt.overlayIssues,
        note: "save_template rejected the call",
      };
    case "unsaved":
      return {
        ...emptyScore(),
        outcome: "partial",
        paths: attempt.paths,
        traps: attempt.traps,
        overlayIssues: attempt.overlayIssues,
        fidelity: attempt.fidelity,
        note: "authored DOCX was not saved",
      };
    case "saved": {
      const clean =
        attempt.paths.missing.length === 0 &&
        attempt.paths.extra.length === 0 &&
        Object.values(attempt.traps).every((count) => count === 0) &&
        attempt.overlayIssues.length === 0 &&
        attempt.configDefects.length === 0 &&
        attempt.fidelity.length === 0 &&
        !hasRoundTripDefect(attempt.roundTrip);
      return {
        outcome: clean ? "pass" : "partial",
        paths: attempt.paths,
        traps: attempt.traps,
        overlayIssues: attempt.overlayIssues,
        configDefects: attempt.configDefects,
        fidelity: attempt.fidelity,
        roundTrip: attempt.roundTrip,
        note: null,
      };
    }
    default:
      return assertNever(attempt);
  }
};

/** A turn error overrides completion, but never erases attempt evidence that
 * was already produced before the provider or stream failed. */
export const scoreAuthoringRun = ({
  turnError,
  attempt,
}: ScoreAuthoringRunOptions): AuthoringRunScore => {
  const score = scoreAttempt(attempt);
  return turnError === null
    ? score
    : { ...score, outcome: "error", note: turnError };
};

// ── Syntax quiz ───────────────────────────────────────────

/** Marker answers are compared with all whitespace removed, so
 *  `{{ attorneys.name }}` and `{{attorneys.name}}` are the same answer. */
const normalizeMarkerAnswer = (value: string): string =>
  value.replaceAll(/\s+/gu, "");

type QuizAnswerKey = string;

type SyntaxQuizScore = {
  correct: number;
  total: number;
  /** Keys of the questions answered wrong, for the report. */
  wrong: string[];
};

/**
 * Score the comprehension subset exactly: a string answer must match the
 * expected marker after whitespace removal, a boolean answer must match
 * outright. A missing or wrongly-typed answer is wrong, never absent.
 */
export const scoreSyntaxQuiz = (
  answers: Record<string, unknown> | null,
  expected: Readonly<Record<QuizAnswerKey, string | boolean>>,
): SyntaxQuizScore => {
  const keys = Object.keys(expected);
  if (answers === null) {
    return { correct: 0, total: keys.length, wrong: keys };
  }
  const wrong = keys.filter((key) => {
    const want = expected[key];
    const got = answers[key];
    if (typeof want === "boolean") {
      return got !== want;
    }
    return (
      typeof got !== "string" ||
      normalizeMarkerAnswer(got) !== normalizeMarkerAnswer(want ?? "")
    );
  });
  return { correct: keys.length - wrong.length, total: keys.length, wrong };
};
