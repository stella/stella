/**
 * Deterministic scoring for the template authoring eval
 * (`evals/template-authoring.ts`). Kept in its own module because the eval
 * script runs a paid model turn at import time: the scoring has to be
 * importable, and unit-testable, without that.
 *
 * Everything here is pure. The eval feeds in what the model produced (the
 * marked-up document blocks, the `fields` overlay it passed, the paths the
 * real discovery found) plus the outcome of the real fill round trip, and
 * gets back a run score whose every field is a count or a named code.
 *
 * A trap is a placement or a spelling the ENGINE refuses, so the detectors
 * ask the engine's own parsers (`scanMarkers`, `classifyMarkerDefect`,
 * `detectRowBlockPair`, `parseInlineConditions`) and, for a configuration
 * trap, the refusals `partitionFieldOverlay` actually returned, rather than
 * re-deriving the rules: a placement the engine learns to run, or an overlay
 * shape it learns to fold, stops being a trap here on the same day.
 */

import {
  assertNever,
  blockDirectiveLinePattern,
  classifyMarkerDefect,
  detectRowBlockPair,
  isBlockDirectiveKind,
  type ScannedMarker,
  scanInvalidMarkers,
  scanMarkers,
} from "@stll/template-conditions";

import { parseInlineConditions } from "@/api/lib/docx/inline-conditions";
import {
  conditionReferencesOnlySelf,
  LOOKUP_OWNERSHIP_REFUSAL,
} from "@/api/lib/templates/field-overlay";

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
  lookup?: object | undefined;
};

/** One refusal the production overlay partition returned, naming the entry it
 *  refuses by its position in the overlay that was sent. */
type OverlayIssueView = {
  index: number;
  message: string;
};

/**
 * Grammar mistakes an agent authoring a stella template actually makes. Each
 * code names one confusion, so a report says which rule the reference
 * resources failed to teach rather than "the template was wrong".
 */
export const GRAMMAR_TRAP_CODES = [
  /** `{{ name }}` inside `{% for attorney in attorneys %}` instead of
   *  `{{ attorney.name }}` — the loop's item is addressed by its alias. */
  "unaliased_item_path",
  /** A marker in the old dialect (`{{#each}}`, `{{@num:k}}`). */
  "legacy_marker",
  /** A Jinja tag this dialect does not run (`{% set %}`, `{% macro %}`). */
  "unsupported_tag",
  /** A filter outside the field-configuration catalogue (`| upper`). */
  "unknown_filter",
  /** Arithmetic, a call or a Python literal inside `{{ }}`. */
  "python_expression",
  /** `{{attorneys[0].name}}` instead of the numeric segment `attorneys.0.name`. */
  "bracket_index",
  /** One value given a per-language path (`date_pl` beside `date_en`). */
  "language_variant_path",
  /** A block directive in a placement no engine runs: not the paragraph form,
   *  not a row block's opener/closer pair, and not a span the inline engine
   *  parses (`{% if x %}…{% endif %}` within one paragraph). */
  "block_marker_inline",
  /** A lookup declared per leaf (`company.krs`) instead of one parent with
   *  formats, and still refused after the engine folds a leaf that merely
   *  restates its parent's format. A leaf refused for anything else it
   *  carries beside a correctly placed parent lookup is a configuration
   *  mistake, reported as the overlay issue it is, not as a grammar trap. */
  "lookup_not_parent",
  /** A `condition` on a field the person answers as a yes/no question. */
  "condition_on_input",
] as const;

type GrammarTrapCode = (typeof GRAMMAR_TRAP_CODES)[number];

/** Total over {@link GRAMMAR_TRAP_CODES}: a new code has no default. */
export type GrammarTrapCounts = Record<GrammarTrapCode, number>;

const zeroTrapCounts = (): GrammarTrapCounts => ({
  unaliased_item_path: 0,
  legacy_marker: 0,
  unsupported_tag: 0,
  unknown_filter: 0,
  python_expression: 0,
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

/** The paragraph text with those markers cut out, which is what the inline
 *  engine reads once the row engine has hoisted a row block's pair away. */
const withoutMarkers = (
  text: string,
  markers: readonly ScannedMarker[],
): string => {
  let remainder = text;
  for (const marker of [...markers].toSorted((a, b) => b.start - a.start)) {
    remainder = remainder.slice(0, marker.start) + remainder.slice(marker.end);
  }
  return remainder;
};

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

type DetectGrammarTrapsOptions = {
  /** The document the model authored, in order. */
  blocks: readonly AuthoredBlock[];
  /** The `fields` entries it passed to `configure_template_fields`. */
  overlay: readonly OverlayFieldView[];
  /** What `partitionFieldOverlay` refused of those entries. */
  overlayIssues: readonly OverlayIssueView[];
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
  overlayIssues,
  booleanInputPaths,
}: DetectGrammarTrapsOptions): GrammarTrapCounts => {
  const counts = zeroTrapCounts();
  /** The loops open at this point, each with the alias its body must use. */
  const eachStack: { alias: string; path: string }[] = [];
  const placeholderPaths: string[] = [];

  for (const { rowBlockStarts, text } of paragraphsOf(blocks)) {
    // The grammar package diagnoses a rejected span; the eval only counts what
    // it names, so a defect kind added there lands here with no second list.
    for (const { form, inner } of scanInvalidMarkers(text)) {
      const defect = classifyMarkerDefect(inner, form);
      if (defect === null) {
        continue;
      }
      switch (defect.kind) {
        case "legacy_marker":
          counts.legacy_marker += 1;
          break;
        case "unsupported_tag":
          counts.unsupported_tag += 1;
          break;
        case "unknown_filter":
          counts.unknown_filter += 1;
          break;
        case "python_expression":
          counts.python_expression += 1;
          break;
        case "bracket_index":
          counts.bracket_index += 1;
          break;
        default:
          assertNever(defect.kind);
      }
    }

    const markers = scanMarkers(text);
    // A row block's two markers are placed as the grammar allows: the opener
    // in front of one cell's text, the closer behind another's, and the row
    // engine hoists them out of the cell before anything else reads it.
    const rowBlockMarkers = markers.filter((marker) =>
      rowBlockStarts.has(marker.start),
    );
    const blockMarkers = markers.filter(
      (marker) =>
        isBlockDirectiveKind(marker.meta.kind) &&
        !rowBlockStarts.has(marker.start),
    );
    // Three placements the engine runs, so none of them is a trap: no block
    // directive left for it at all, a paragraph that is one directive and
    // nothing else (the block form), and a span the inline engine parses. Only
    // what `parseInlineConditions` refuses is a placement that renders as
    // literal markers.
    if (
      blockMarkers.length > 0 &&
      !blockDirectiveLinePattern().test(text) &&
      !parseInlineConditions(withoutMarkers(text, rowBlockMarkers)).ok
    ) {
      counts.block_marker_inline += 1;
    }

    for (const { meta } of markers) {
      if (meta.kind === "for") {
        eachStack.push({ alias: meta.alias, path: meta.path });
        continue;
      }
      if (meta.kind === "endfor") {
        eachStack.pop();
        continue;
      }
      if (meta.kind !== "placeholder") {
        continue;
      }
      const { expr } = meta;
      placeholderPaths.push(expr);
      const enclosing = eachStack.at(-1);
      if (
        enclosing !== undefined &&
        ![enclosing.alias, enclosing.path].some(
          (head) => expr === head || expr.startsWith(`${head}.`),
        )
      ) {
        counts.unaliased_item_path += 1;
      }
    }
  }

  counts.language_variant_path = countLanguageVariants([
    ...new Set(placeholderPaths),
  ]);

  // The trap is the per-leaf lookup shape, counted only where the engine
  // still refuses it: a leaf that merely restates its parent's format folds
  // away. A leaf refused for what it carries BESIDE a correctly placed parent
  // lookup is a configuration mistake, and stays the overlay issue it is.
  for (const { index, message } of overlayIssues) {
    const leaf = overlay[index];
    if (
      message.includes(LOOKUP_OWNERSHIP_REFUSAL) &&
      leaf?.lookup !== undefined &&
      leaf.path.includes(".")
    ) {
      counts.lookup_not_parent += 1;
    }
  }

  // A condition that reads only the field's own value is one the engine drops
  // before it configures anything, so it is no longer a trap; what remains is
  // a condition that makes a question the person was meant to answer derived.
  const booleanInputs = new Set(booleanInputPaths);
  for (const field of overlay) {
    const { condition } = field;
    if (
      condition !== undefined &&
      booleanInputs.has(field.path) &&
      !conditionReferencesOnlySelf(field.path, condition)
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
  /** The fill refused the saved template outright, so nothing rendered. It
   *  is the round trip that failed, not the configuration: every entry the
   *  call carried had already landed. */
  fillError: string | null;
};

export const cleanRoundTrip = (): RoundTripDefects => ({
  leftoverMarkers: 0,
  blankRepeatedRows: 0,
  conditionalRowKept: false,
  dateLocaleMismatch: false,
  fillError: null,
});

const hasRoundTripDefect = (roundTrip: RoundTripDefects): boolean =>
  roundTrip.leftoverMarkers > 0 ||
  roundTrip.blankRepeatedRows > 0 ||
  roundTrip.conditionalRowKept ||
  roundTrip.dateLocaleMismatch ||
  roundTrip.fillError !== null;

/**
 * An overlay issue's `path` names either the entry it refuses (`fields.3`) or
 * the single property it dropped out of an entry that otherwise applied
 * (`fields.3.parts`). Only the first means the entry did not land, so the two
 * are told apart here, once, rather than at every reader.
 */
const ENTRY_ISSUE_PATH = /^fields\.\d+$/u;

export const isEntryOverlayIssue = ({ path }: { path: string }): boolean =>
  ENTRY_ISSUE_PATH.test(path);

/**
 * What became of the model's last create/configure call. `rejected` covers the
 * production validations that refuse a call outright (schema, mutually
 * exclusive derived sources, a `path` matching no marker); `invalid-docx`
 * covers bytes that are not a DOCX at all.
 */
/**
 * The workflow's four steps, scored separately so a report says WHICH step a
 * model could not get through rather than only that the run was partial. A
 * later step is never credited without the one before it: a template that was
 * never created cannot have been configured.
 */
export type AuthoringSteps = {
  /** A DOCX was written with exactly the expected marker paths and no
   *  grammar trap, keeping the source wording. */
  authored: boolean;
  /** `create_template` accepted the document. */
  created: boolean;
  /** `configure_template_fields` landed every entry, with no entry-level
   *  issue left, and configured what the brief asked for. A property the
   *  tool site dropped out of an entry that otherwise applied is reported,
   *  never a step failure: the entry landed. */
  configured: boolean;
  /** The fill round trip rendered cleanly. */
  filled: boolean;
};

export const AUTHORING_STEP_NAMES = [
  "authored",
  "created",
  "configured",
  "filled",
] as const satisfies readonly (keyof AuthoringSteps)[];

const noSteps = (): AuthoringSteps => ({
  authored: false,
  created: false,
  configured: false,
  filled: false,
});

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
      /** Entry-level refusals: the entry did not land. */
      overlayIssues: readonly string[];
      /** Properties dropped out of entries that did land. */
      propertyDrops: readonly string[];
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
  steps: AuthoringSteps;
  paths: PathComparison;
  traps: GrammarTrapCounts;
  overlayIssues: readonly string[];
  propertyDrops: readonly string[];
  configDefects: readonly string[];
  fidelity: readonly string[];
  roundTrip: RoundTripDefects;
  /** Why the run is not a `pass`, when the reason is not a defect list. */
  note: string | null;
};

type ScoreAuthoringRunOptions = {
  /** The provider's error, when the turn itself failed. */
  turnError: string | null;
  /** The last attempt at the create/configure pair, or null when the model
   *  never got that far. */
  attempt: SaveAttempt | null;
  /** Whether `create_template` accepted a document at any point in the run,
   *  which the last attempt alone cannot say: a configure call that failed
   *  still followed a create that succeeded. */
  created: boolean;
};

const emptyScore = (): Omit<AuthoringRunScore, "outcome" | "note"> => ({
  steps: noSteps(),
  paths: { missing: [], extra: [] },
  traps: zeroTrapCounts(),
  overlayIssues: [],
  propertyDrops: [],
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
const scoreAttempt = (
  attempt: SaveAttempt | null,
  created: boolean,
): AuthoringRunScore => {
  if (attempt === null) {
    return {
      ...emptyScore(),
      steps: { ...noSteps(), created },
      outcome: "no-call",
      note: "no create_template call",
    };
  }
  switch (attempt.status) {
    case "invalid-docx":
      return {
        ...emptyScore(),
        steps: { ...noSteps(), created },
        outcome: "invalid-docx",
        note: attempt.reason,
      };
    case "rejected":
      return {
        ...emptyScore(),
        steps: { ...noSteps(), created },
        outcome: "partial",
        overlayIssues: attempt.overlayIssues,
        note: "the call was rejected",
      };
    case "unsaved":
      return {
        ...emptyScore(),
        outcome: "partial",
        steps: {
          ...noSteps(),
          authored: authoredCleanly(attempt),
          created,
        },
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
        steps: {
          authored: authoredCleanly(attempt),
          created: true,
          configured:
            attempt.overlayIssues.length === 0 &&
            attempt.configDefects.length === 0,
          filled: !hasRoundTripDefect(attempt.roundTrip),
        },
        paths: attempt.paths,
        traps: attempt.traps,
        overlayIssues: attempt.overlayIssues,
        propertyDrops: attempt.propertyDrops,
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
/** The authoring step alone: the right marker paths, no grammar trap, and
 *  the source wording kept. It is scored the same way whether or not the
 *  document was ever saved. */
const authoredCleanly = (
  attempt: Extract<SaveAttempt, { status: "unsaved" | "saved" }>,
): boolean =>
  attempt.paths.missing.length === 0 &&
  attempt.paths.extra.length === 0 &&
  Object.values(attempt.traps).every((count) => count === 0) &&
  attempt.fidelity.length === 0;

export const scoreAuthoringRun = ({
  turnError,
  attempt,
  created,
}: ScoreAuthoringRunOptions): AuthoringRunScore => {
  const score = scoreAttempt(attempt, created);
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
