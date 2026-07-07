/**
 * Canonical grammar for `{{...}}` template markers — the single source of truth
 * shared by the fill pipeline (api), the editor highlighter (folio), and the
 * read-only preview (web).
 *
 * Add a new directive in ONE place: append its `kind` to {@link DIRECTIVE_KINDS},
 * add a `MarkerMeta` member, and teach {@link classifyMarker} to recognize it.
 * Every scanner that uses {@link scanMarkers} / {@link classifyMarker} then sees
 * it automatically, and every exhaustive `switch` over a marker's kind (closed
 * with {@link assertNever}) fails to compile at any consumer that has not yet
 * handled it. That is what makes "added a directive server-side but a recognizer
 * elsewhere silently ignored it" a build error rather than a latent bug.
 *
 * No consumer should define its own `{{...}}` regex. The low-level pattern
 * factories below exist so handlers that mutate raw XML/text reuse the exact
 * same literals; recognizers should prefer the high-level scanner.
 */

import { panic } from "better-result";

// ── Directive kinds ──────────────────────────────────────

export const DIRECTIVE_KINDS = [
  "placeholder",
  "clause",
  "num",
  "ref",
  "index",
  "count",
  "if",
  "elseif",
  "else",
  "endif",
  "each",
  "endeach",
] as const;

export type DirectiveKind = (typeof DIRECTIVE_KINDS)[number];

/** Directives that occupy their own paragraph (block-level), opener→closer. */
export const BLOCK_DIRECTIVE_KINDS = [
  "if",
  "elseif",
  "else",
  "endif",
  "each",
  "endeach",
] as const satisfies readonly DirectiveKind[];

const BLOCK_KIND_SET: ReadonlySet<DirectiveKind> = new Set(
  BLOCK_DIRECTIVE_KINDS,
);

export const isBlockDirectiveKind = (kind: DirectiveKind): boolean =>
  BLOCK_KIND_SET.has(kind);

// ── Parsed marker (discriminated union) ──────────────────

export type MarkerMeta =
  | { kind: "placeholder"; expr: string }
  | { kind: "clause"; name: string; version: string | undefined }
  | { kind: "num"; key: string }
  | { kind: "ref"; key: string }
  | { kind: "index" }
  | { kind: "count" }
  | { kind: "if"; expr: string }
  | { kind: "elseif"; expr: string }
  | { kind: "else" }
  | { kind: "endif" }
  | { kind: "each"; expr: string }
  | { kind: "endeach" };

// ── Low-level pattern factories (the canonical literals) ──
// Each returns a fresh RegExp so callers never share `lastIndex` state.

/** Any `{{...}}` marker; group 1 is the inner text (untrimmed — callers trim). */
export const markerPattern = (): RegExp =>
  // A single greedy `[^{}]*` matches the inner text in one pass. The previous
  // `\s*([^{}]*?)\s*` form backtracks polynomially on a `{{` with no closing
  // `}}` (\s overlaps [^{}]); this scans the whole document, so keep it linear.
  /\{\{(?<inner>[^{}]*)\}\}/gu;

/** Inline field / clause / numbering marker (inner allows the directive sigils). */
export const placeholderPattern = (): RegExp =>
  /\{\{\s*(?<name>[\p{L}\p{N}_.@:-]+)\s*\}\}/gu;

/** `{{@clause:Name}}` / `{{@clause:Name:v3}}` — `name` and `modifier` groups. */
export const clauseSlotPattern = (): RegExp =>
  /\{\{\s*@clause:(?<name>[^:}\s]+)(?::(?<modifier>[^}\s]+))?\s*\}\}/gu;

/** `{{@num:Key}}` — the `key` group. */
export const numPattern = (): RegExp =>
  /\{\{\s*@num:(?<key>[\p{L}\p{N}_.-]+)\s*\}\}/gu;

/** `{{@ref:Key}}` — the `key` group. */
export const refPattern = (): RegExp =>
  /\{\{\s*@ref:(?<key>[\p{L}\p{N}_.-]+)\s*\}\}/gu;

/** `{{@index}}` — the 1-based position within the innermost enclosing loop. */
export const indexPattern = (): RegExp => /\{\{\s*@index\s*\}\}/gu;

/** `{{@count}}` — the item count of the innermost enclosing loop. */
export const countPattern = (): RegExp => /\{\{\s*@count\s*\}\}/gu;

/** Cheap presence test for any numbering marker (no capture). */
export const hasNumberingPattern = (): RegExp => /\{\{\s*@(?:num|ref):/u;

/** Cheap presence test for any block directive (no capture). */
export const hasBlockDirectivePattern = (): RegExp => /\{\{\s*[#/]/u;

/** A whole line that is a single block directive — `tag` and `expr` groups. */
export const blockDirectiveLinePattern = (): RegExp =>
  /^\s*\{\{\s*(?<tag>#if|#elseif|#else|#each|\/if|\/each)\b(?<expr>[^{}]*)\}\}\s*$/u;

// ── Classifier ───────────────────────────────────────────

// Anchored forms used to classify the inner text of one marker.
const FIELD_PATH_RE = /^[\p{L}\p{N}_.-]+$/u;
const UNSAFE_FIELD_PATH_SEGMENTS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

/** Whether `value` is a valid field path per the marker grammar (dotted
 *  segments of letters/digits/underscore/dash — no brackets or spaces). */
export const isFieldPath = (value: string): boolean =>
  FIELD_PATH_RE.test(value);

/** Whether `value` is safe to use as a dotted object path. */
export const isSafeFieldPath = (value: string): boolean =>
  isFieldPath(value) &&
  value.split(".").every((segment) => !UNSAFE_FIELD_PATH_SEGMENTS.has(segment));

// A NEW `{{@clause:NAME}}` slot name. Deliberately tighter than the parse
// grammar (`clauseSlotPattern`'s name group is `[^:}\s]+`): the fill pipeline
// substitutes marker text through `placeholderPattern`, whose name charset is
// `[\p{L}\p{N}_.@:-]`, so a name this validator admits but that charset lacks
// (e.g. `foo/bar`) would pass discovery and the health check yet survive as
// literal text in the filled document. Restrict authoring to the
// letters/digits/`_.-` intersection (`@` and `:` are structural in the clause
// marker itself).
const CLAUSE_SLOT_NAME_RE = /^[\p{L}\p{N}_.-]+$/u;

/** Whether `value` is a valid name for authoring a `{{@clause:NAME}}` slot:
 *  the intersection of the clause-slot parse grammar and the fill pipeline's
 *  placeholder charset, so every accepted name round-trips through fill. */
export const isClauseSlotName = (value: string): boolean =>
  CLAUSE_SLOT_NAME_RE.test(value);
const CLAUSE_INNER_RE = /^@clause:(?<name>[^:}\s]+)(?::(?<version>[^}\s]+))?$/u;
const NUM_INNER_RE = /^@num:(?<key>[\p{L}\p{N}_.-]+)$/u;
const REF_INNER_RE = /^@ref:(?<key>[\p{L}\p{N}_.-]+)$/u;
const INDEX_INNER_RE = /^@index$/u;
const COUNT_INNER_RE = /^@count$/u;
// `\b(.*)` rather than `\b\s*(.*)`: the overlapping `\s*`/`.*` quantifiers are
// polynomial; group 2 is trimmed at the use site below, so drop the `\s*`.
const BLOCK_INNER_RE =
  /^(?<token>#if|#elseif|#else|#each|\/if|\/each)\b(?<expr>.*)$/u;

/**
 * Classify the inner text of a `{{...}}` marker. Returns `null` when the text is
 * not a recognized directive (so a recognizer can leave stray braces alone).
 */
export const classifyMarker = (innerRaw: string): MarkerMeta | null => {
  const inner = innerRaw.trim();

  const block = BLOCK_INNER_RE.exec(inner);
  if (block) {
    const token = block.groups?.["token"] ?? "";
    const expr = (block.groups?.["expr"] ?? "").trim();
    if (token === "#if") {
      return { kind: "if", expr };
    }
    if (token === "#elseif") {
      return { kind: "elseif", expr };
    }
    if (token === "#each") {
      return { kind: "each", expr };
    }
    if (token === "#else") {
      return { kind: "else" };
    }
    if (token === "/if") {
      return { kind: "endif" };
    }
    if (token === "/each") {
      return { kind: "endeach" };
    }
  }

  const clause = CLAUSE_INNER_RE.exec(inner);
  if (clause) {
    return {
      kind: "clause",
      name: clause.groups?.["name"] ?? "",
      version: clause.groups?.["version"],
    };
  }

  const num = NUM_INNER_RE.exec(inner);
  if (num) {
    return { kind: "num", key: num.groups?.["key"] ?? "" };
  }

  const ref = REF_INNER_RE.exec(inner);
  if (ref) {
    return { kind: "ref", key: ref.groups?.["key"] ?? "" };
  }

  if (INDEX_INNER_RE.test(inner)) {
    return { kind: "index" };
  }

  if (COUNT_INNER_RE.test(inner)) {
    return { kind: "count" };
  }

  if (FIELD_PATH_RE.test(inner)) {
    return { kind: "placeholder", expr: inner };
  }

  return null;
};

// ── Scanner ──────────────────────────────────────────────

export type ScannedMarker = {
  /** Offset of `{{` in the source text. */
  start: number;
  /** Offset just past `}}`. */
  end: number;
  /** The full matched marker, e.g. `{{@num:scope}}`. */
  raw: string;
  /** The (untrimmed) inner text. */
  inner: string;
  meta: MarkerMeta;
};

/**
 * Find every recognized `{{...}}` marker in `text`, in document order, with
 * offsets and classified metadata. Unrecognized `{{...}}` spans are skipped.
 */
export const scanMarkers = (text: string): ScannedMarker[] => {
  const re = markerPattern();
  const out: ScannedMarker[] = [];
  let match = re.exec(text);
  while (match !== null) {
    // markerPattern captures surrounding whitespace now; trim to the directive.
    const inner = (match[1] ?? "").trim();
    const meta = classifyMarker(inner);
    if (meta) {
      out.push({
        start: match.index,
        end: match.index + match[0].length,
        raw: match[0],
        inner,
        meta,
      });
    }
    match = re.exec(text);
  }
  return out;
};

/** A `{{...}}` span that looks like a marker but classifies to nothing. */
export type InvalidMarker = {
  /** Offset of `{{` in the source text. */
  start: number;
  /** Offset just past `}}`. */
  end: number;
  /** The full matched span, e.g. `{{my field}}`. */
  raw: string;
  /** The (trimmed) inner text. */
  inner: string;
};

/**
 * Find every `{{...}}` span whose inner text is NOT a recognized directive —
 * near-misses an author clearly meant as markers but that every recognizer
 * skips, so they print literally at fill time (e.g. `{{my field}}` with a
 * space, `{{@clause:}}` with no name). Offsets and raw text are shaped like
 * {@link scanMarkers} results, minus the classified `meta`. This is the exact
 * complement of {@link scanMarkers}: a span is in one list or the other.
 */
export const scanInvalidMarkers = (text: string): InvalidMarker[] => {
  const re = markerPattern();
  const out: InvalidMarker[] = [];
  let match = re.exec(text);
  while (match !== null) {
    const inner = (match[1] ?? "").trim();
    if (classifyMarker(inner) === null) {
      out.push({
        start: match.index,
        end: match.index + match[0].length,
        raw: match[0],
        inner,
      });
    }
    match = re.exec(text);
  }
  return out;
};

/** Exhaustiveness guard — pass the discriminant in a `switch` default branch. */
export const assertNever = (value: never): never =>
  panic(`Unhandled template directive: ${JSON.stringify(value)}`);
