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
  /\{\{([^{}]*)\}\}/gu;

/** Inline field / clause / numbering marker (inner allows the directive sigils). */
export const placeholderPattern = (): RegExp =>
  /\{\{\s*([\p{L}\p{N}_.@:-]+)\s*\}\}/gu;

/** `{{@clause:Name}}` / `{{@clause:Name:v3}}` — group 1 name, group 2 version. */
export const clauseSlotPattern = (): RegExp =>
  /\{\{\s*@clause:([^:}\s]+)(?::([^}\s]+))?\s*\}\}/gu;

/** `{{@num:Key}}` — group 1 is the key. */
export const numPattern = (): RegExp =>
  /\{\{\s*@num:([\p{L}\p{N}_.-]+)\s*\}\}/gu;

/** `{{@ref:Key}}` — group 1 is the key. */
export const refPattern = (): RegExp =>
  /\{\{\s*@ref:([\p{L}\p{N}_.-]+)\s*\}\}/gu;

/** Cheap presence test for any numbering marker (no capture). */
export const hasNumberingPattern = (): RegExp => /\{\{\s*@(?:num|ref):/u;

/** Cheap presence test for any block directive (no capture). */
export const hasBlockDirectivePattern = (): RegExp => /\{\{\s*[#/]/u;

/** A whole line that is a single block directive — group 1 token, group 2 expr. */
export const blockDirectiveLinePattern = (): RegExp =>
  // oxlint-disable-next-line sonarjs/slow-regex -- runs on one OOXML paragraph at a time
  /^\s*\{\{\s*(#if|#elseif|#else|#each|\/if|\/each)\s*(.*?)\}\}\s*$/u;

// ── Classifier ───────────────────────────────────────────

// Anchored forms used to classify the inner text of one marker.
const FIELD_PATH_RE = /^[\p{L}\p{N}_.-]+$/u;
const CLAUSE_INNER_RE = /^@clause:([^:}\s]+)(?::([^}\s]+))?$/u;
const NUM_INNER_RE = /^@num:([\p{L}\p{N}_.-]+)$/u;
const REF_INNER_RE = /^@ref:([\p{L}\p{N}_.-]+)$/u;
// `\b(.*)` rather than `\b\s*(.*)`: the overlapping `\s*`/`.*` quantifiers are
// polynomial; group 2 is trimmed at the use site below, so drop the `\s*`.
const BLOCK_INNER_RE = /^(#if|#elseif|#else|#each|\/if|\/each)\b(.*)$/u;

/**
 * Classify the inner text of a `{{...}}` marker. Returns `null` when the text is
 * not a recognized directive (so a recognizer can leave stray braces alone).
 */
export const classifyMarker = (innerRaw: string): MarkerMeta | null => {
  const inner = innerRaw.trim();

  const block = BLOCK_INNER_RE.exec(inner);
  if (block) {
    const token = block[1] ?? "";
    const expr = (block[2] ?? "").trim();
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
    return { kind: "clause", name: clause[1] ?? "", version: clause[2] };
  }

  const num = NUM_INNER_RE.exec(inner);
  if (num) {
    return { kind: "num", key: num[1] ?? "" };
  }

  const ref = REF_INNER_RE.exec(inner);
  if (ref) {
    return { kind: "ref", key: ref[1] ?? "" };
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

/** Exhaustiveness guard — pass the discriminant in a `switch` default branch. */
export const assertNever = (value: never): never =>
  panic(`Unhandled template directive: ${JSON.stringify(value)}`);
