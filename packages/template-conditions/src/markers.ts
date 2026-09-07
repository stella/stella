/**
 * Canonical grammar for the docxtpl dialect of Jinja — the single source of
 * truth shared by the fill pipeline (api), the editor highlighter (folio), and
 * the read-only preview (web).
 *
 * Two spans carry meaning: an output marker `{{ ... }}` prints a value, and a
 * tag `{% ... %}` opens or closes a block. A tag may carry a docxtpl placement
 * prefix — `{%p ... %}` owns its paragraph, `{%tr ... %}` owns its table row —
 * and a bare tag is placed by the leniency rules the consumer applies.
 *
 * Add a new directive to `MarkerMeta` and teach {@link classifyMarker} to
 * recognize it. Compile-time totality checks then require its ordered runtime
 * value and its block/inline disposition, while exhaustive consumer switches
 * fail until they handle it.
 *
 * No consumer should define its own marker regex. The low-level pattern
 * factories below exist so handlers that mutate raw XML/text reuse the exact
 * same literals; recognizers should prefer the high-level scanner.
 */

import { panic } from "better-result";

// ── Parsed marker and directive kinds ────────────────────

/** A literal an author can write inside a filter or function call. */
export type MarkerLiteral = string | number | boolean;

/** One argument of a filter call: positional, or `name=value`. */
export type FilterArgument =
  | { kind: "positional"; value: MarkerLiteral }
  | { kind: "keyword"; name: string; value: MarkerLiteral };

/** One `| name` / `| name(args)` step of an output marker's filter chain. */
export type FilterCall = {
  name: FilterName;
  args: readonly FilterArgument[];
};

/** The loop properties addressable inside a `{% for %}` body. */
export const LOOP_PROPERTIES = [
  "index",
  "index0",
  "first",
  "last",
  "length",
] as const;

export type LoopProperty = (typeof LOOP_PROPERTIES)[number];

export type MarkerMeta =
  | { kind: "placeholder"; expr: string; filters: readonly FilterCall[] }
  | { kind: "clause"; name: string; version: string | undefined }
  | { kind: "num"; key: string }
  | { kind: "ref"; key: string }
  | { kind: "loop"; property: LoopProperty }
  | { kind: "if"; expr: string }
  | { kind: "elif"; expr: string }
  | { kind: "else" }
  | { kind: "endif" }
  | { kind: "for"; alias: string; path: string }
  | { kind: "endfor" };

export type DirectiveKind = MarkerMeta["kind"];

const DIRECTIVE_KIND_VALUES = [
  "placeholder",
  "clause",
  "num",
  "ref",
  "loop",
  "if",
  "elif",
  "else",
  "endif",
  "for",
  "endfor",
] as const satisfies readonly DirectiveKind[];

type MissingDirectiveKind = Exclude<
  DirectiveKind,
  (typeof DIRECTIVE_KIND_VALUES)[number]
>;

true satisfies MissingDirectiveKind extends never ? true : never;

export const DIRECTIVE_KINDS = DIRECTIVE_KIND_VALUES;

const DIRECTIVE_PLACEMENT = {
  placeholder: "inline",
  clause: "inline",
  num: "inline",
  ref: "inline",
  loop: "inline",
  if: "block",
  elif: "block",
  else: "block",
  endif: "block",
  for: "block",
  endfor: "block",
} as const satisfies Record<DirectiveKind, "block" | "inline">;

export type BlockDirectiveKind = {
  [TKind in DirectiveKind]: (typeof DIRECTIVE_PLACEMENT)[TKind] extends "block"
    ? TKind
    : never;
}[DirectiveKind];

const BLOCK_DIRECTIVE_KIND_VALUES = [
  "if",
  "elif",
  "else",
  "endif",
  "for",
  "endfor",
] as const satisfies readonly BlockDirectiveKind[];

type MissingBlockDirectiveKind = Exclude<
  BlockDirectiveKind,
  (typeof BLOCK_DIRECTIVE_KIND_VALUES)[number]
>;

true satisfies MissingBlockDirectiveKind extends never ? true : never;

/** Directives that occupy their own paragraph, in canonical grammar order. */
export const BLOCK_DIRECTIVE_KINDS = BLOCK_DIRECTIVE_KIND_VALUES;

export const isBlockDirectiveKind = (
  kind: unknown,
): kind is BlockDirectiveKind =>
  typeof kind === "string" &&
  BLOCK_DIRECTIVE_KINDS.some((blockKind) => blockKind === kind);

// ── Functions and filters ────────────────────────────────

/** Callable forms inside `{{ }}` that address document machinery rather than a
 *  fill value. */
const FUNCTION_NAMES = ["clause", "num", "ref"] as const;

type FunctionName = (typeof FUNCTION_NAMES)[number];

/**
 * Every filter the dialect accepts on a fillable value. The names are the
 * grammar's; which manifest property each one writes is decided by the field
 * catalogue in the api, which is total over BOTH this list and the manifest
 * keys, so neither side can gain an entry the other has not decided.
 */
export const FILTER_NAMES = [
  "text",
  "number",
  "date",
  "checkbox",
  "select",
  "options_from",
  "label",
  "hint",
  "required",
  "pattern",
  "min",
  "max",
  "min_length",
  "max_length",
  "min_items",
  "max_items",
  "ai",
  "lookup",
  "matter",
  "contact",
  "party",
  "attorney",
  "firm",
  "formula",
  "condition",
] as const;

export type FilterName = (typeof FILTER_NAMES)[number];

const isFilterName = (value: string): value is FilterName =>
  FILTER_NAMES.some((name) => name === value);

const isFunctionName = (value: string): value is FunctionName =>
  FUNCTION_NAMES.some((name) => name === value);

// ── Normalisation ────────────────────────────────────────

// Word autocorrects a typed quote into a typographic one and a typed space
// into a non-breaking space, neither of which any parser below accepts. The
// author sees the marker they meant, so normalise rather than reject.
const SMART_DOUBLE_QUOTES = /[“”„«»]/gu;
const SMART_SINGLE_QUOTES = /[‘’‚]/gu;
const FIXED_SPACES = /[    ]/gu;

/** Normalise one marker's inner text: typographic quotes become straight
 *  quotes, fixed-width spaces become ordinary ones. */
export const normalizeMarkerInner = (inner: string): string =>
  inner
    .replace(SMART_DOUBLE_QUOTES, '"')
    .replace(SMART_SINGLE_QUOTES, "'")
    .replace(FIXED_SPACES, " ");

// ── Low-level pattern factories (the canonical literals) ──
// Each returns a fresh RegExp so callers never share `lastIndex` state.

/**
 * Any marker span: an output `{{...}}` (group `output`) or a tag `{%...%}`
 * (group `statement`, with the docxtpl placement in group `prefix`).
 *
 * Every alternative is built from single-character alternatives that cannot
 * overlap, so the scan is linear on adversarial input: a `{{` with no closing
 * `}}` costs one failed pass, not a polynomial retry.
 */
export const markerPattern = (): RegExp =>
  /\{\{(?<output>[^{}]*)\}\}|\{%(?:(?<prefix>tr|p)(?=\s))?(?<statement>(?:[^{}%]|%(?!\}))*)%\}/gu;

/** Inline value marker, including its filter chain; group `name` is the path
 *  the value comes from and group `filters` the untouched chain. */
export const placeholderPattern = (): RegExp =>
  /\{\{\s*(?<name>[\p{L}\p{N}_.-]+)\s*(?<filters>\|(?:[^{}]*)?)?\}\}/gu;

// A function argument may be written with either quote, and Word turns either
// into its typographic pair as the author types. The classifier normalises
// those before parsing; the literal patterns below run over raw run text, so
// they accept the opening and closing forms directly. `\s*` already covers the
// non-breaking spaces Word inserts, which `\s` matches.
/** Any character that opens a quoted function argument. */
const OPEN_QUOTE = String.raw`["'“„«‘‚]`;
/** Any character that closes one. */
const CLOSE_QUOTE = String.raw`["'”»’]`;
/** Everything a quoted argument may hold: no quote of either shape. */
const QUOTED_BODY = String.raw`[^"'“”„«»‘’‚]*`;

/** `{{ clause("Name") }}` / `{{ clause("Name", "v3") }}`. */
export const clauseSlotPattern = (): RegExp =>
  new RegExp(
    String.raw`\{\{\s*clause\(\s*${OPEN_QUOTE}(?<name>${QUOTED_BODY})${CLOSE_QUOTE}\s*(?:,\s*${OPEN_QUOTE}(?<modifier>${QUOTED_BODY})${CLOSE_QUOTE}\s*)?\)\s*\}\}`,
    "gu",
  );

const numberingPattern = (fn: "num" | "ref"): RegExp =>
  new RegExp(
    String.raw`\{\{\s*${fn}\(\s*${OPEN_QUOTE}(?<key>[\p{L}\p{N}_.-]+)${CLOSE_QUOTE}\s*\)\s*\}\}`,
    "gu",
  );

/** `{{ num("key") }}` — the `key` group. */
export const numPattern = (): RegExp => numberingPattern("num");

/** `{{ ref("key") }}` — the `key` group. */
export const refPattern = (): RegExp => numberingPattern("ref");

/** `{{ loop.index }}` and its siblings — the `property` group. */
export const loopPattern = (): RegExp =>
  /\{\{\s*loop\.(?<property>index0|index|first|last|length)\s*\}\}/gu;

/** Cheap presence test for any numbering marker (no capture). */
export const hasNumberingPattern = (): RegExp => /\{\{\s*(?:num|ref)\s*\(/u;

/** Cheap presence test for any tag (no capture). */
export const hasBlockDirectivePattern = (): RegExp => /\{%/u;

/** A whole line that is a single block tag — `prefix`, `tag` and `expr`. */
export const blockDirectiveLinePattern = (): RegExp =>
  /^\s*\{%(?:(?<prefix>tr|p)(?=\s))?\s*(?<tag>if|elif|else|endif|for|endfor)\b(?<expr>(?:[^{}%]|%(?!\}))*)%\}\s*$/u;

// ── Field paths ──────────────────────────────────────────

// Anchored forms used to classify the inner text of one marker.
const FIELD_PATH_RE = /^[\p{L}\p{N}_.-]+$/u;
const IDENTIFIER_RE = /^[\p{L}_][\p{L}\p{N}_-]*$/u;
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

// A NEW `clause("NAME")` slot name. The fill pipeline substitutes value
// markers through `placeholderPattern`, whose name charset is
// `[\p{L}\p{N}_.-]`; restricting authoring to that same charset keeps a name
// this validator admits from surviving as literal text in the filled document.
const CLAUSE_SLOT_NAME_RE = /^[\p{L}\p{N}_.-]+$/u;

/** Whether `value` is a valid name for authoring a `clause("NAME")` slot. */
export const isClauseSlotName = (value: string): boolean =>
  CLAUSE_SLOT_NAME_RE.test(value);

const isLoopProperty = (value: string): value is LoopProperty =>
  LOOP_PROPERTIES.some((property) => property === value);

// ── Expression tokenizer for output markers ──────────────

type ArgumentScan = {
  args: FilterArgument[];
  /** Offset just past the closing `)`. A list that never closed is no scan at
   *  all, so this is always a real offset. */
  end: number;
};

const NUMBER_LITERAL_RE = /^-?\d+(?:\.\d+)?$/u;

const literalFromBareToken = (raw: string): MarkerLiteral | null => {
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  if (NUMBER_LITERAL_RE.test(raw)) {
    return Number(raw);
  }
  return null;
};

/**
 * Scan a `"..."` / `'...'` literal starting at the opening quote, honouring
 * `\`-escapes. One linear pass; an unterminated literal closes at end of
 * input, matching the degrade-gracefully policy of the condition parser.
 */
const scanQuoted = (
  text: string,
  start: number,
): { value: string; end: number } => {
  const quote = text[start];
  let i = start + 1;
  let value = "";
  while (i < text.length) {
    const ch = text[i];
    if (ch === quote) {
      return { value, end: i + 1 };
    }
    if (ch === "\\" && i + 1 < text.length) {
      value += text[i + 1];
      i += 2;
      continue;
    }
    value += ch;
    i += 1;
  }
  return { value, end: text.length };
};

/**
 * Scan a parenthesised argument list starting at `(`. Arguments are string,
 * number or boolean literals, optionally named (`adapt=true`). Anything else
 * (an identifier, an operator, a nested call) fails the scan, which is what
 * makes `min(a + 1)` a rejected expression rather than a silently odd filter.
 */
const scanArguments = (text: string, start: number): ArgumentScan | null => {
  const args: FilterArgument[] = [];
  let i = start + 1;
  let expectValue = true;
  let pendingName: string | undefined;

  while (i < text.length) {
    const ch = text[i];
    if (ch === undefined) {
      break;
    }
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i += 1;
      continue;
    }
    if (ch === ")") {
      if (pendingName !== undefined) {
        return null;
      }
      if (!expectValue || args.length === 0) {
        return { args, end: i + 1 };
      }
      // A trailing comma before `)`.
      return null;
    }
    if (ch === ",") {
      if (expectValue) {
        return null;
      }
      expectValue = true;
      i += 1;
      continue;
    }
    if (!expectValue) {
      return null;
    }
    if (ch === '"' || ch === "'") {
      const { value, end } = scanQuoted(text, i);
      args.push(
        pendingName === undefined
          ? { kind: "positional", value }
          : { kind: "keyword", name: pendingName, value },
      );
      pendingName = undefined;
      expectValue = false;
      i = end;
      continue;
    }
    // A bare token: a literal, or a keyword-argument name when `=` follows.
    let j = i;
    while (j < text.length && /[\p{L}\p{N}_.-]/u.test(text[j] ?? "")) {
      j += 1;
    }
    if (j === i) {
      return null;
    }
    const raw = text.slice(i, j);
    if (text[j] === "=" && text[j + 1] !== "=") {
      if (pendingName !== undefined || !IDENTIFIER_RE.test(raw)) {
        return null;
      }
      pendingName = raw;
      i = j + 1;
      continue;
    }
    const value = literalFromBareToken(raw);
    if (value === null) {
      return null;
    }
    args.push(
      pendingName === undefined
        ? { kind: "positional", value }
        : { kind: "keyword", name: pendingName, value },
    );
    pendingName = undefined;
    expectValue = false;
    i = j;
  }
  return null;
};

type FilterChainScan = { filters: FilterCall[] } | { unknownFilter: string };

/**
 * Parse the `| name | name(args)` tail of an output marker. Returns the named
 * unknown filter instead of a chain when one step is not in the catalogue, so
 * the rejection can quote it.
 */
const scanFilterChain = (tail: string): FilterChainScan | null => {
  const filters: FilterCall[] = [];
  let i = 0;
  while (i < tail.length) {
    while (i < tail.length && /\s/u.test(tail[i] ?? "")) {
      i += 1;
    }
    if (i >= tail.length) {
      break;
    }
    if (tail[i] !== "|") {
      return null;
    }
    i += 1;
    while (i < tail.length && /\s/u.test(tail[i] ?? "")) {
      i += 1;
    }
    let j = i;
    while (j < tail.length && /[\p{L}\p{N}_]/u.test(tail[j] ?? "")) {
      j += 1;
    }
    const name = tail.slice(i, j);
    if (name === "") {
      return null;
    }
    if (!isFilterName(name)) {
      return { unknownFilter: name };
    }
    i = j;
    while (i < tail.length && /\s/u.test(tail[i] ?? "")) {
      i += 1;
    }
    if (tail[i] === "(") {
      const scanned = scanArguments(tail, i);
      if (scanned === null) {
        return null;
      }
      filters.push({ name, args: scanned.args });
      i = scanned.end;
      continue;
    }
    filters.push({ name, args: [] });
  }
  return { filters };
};

// ── Classifier ───────────────────────────────────────────

/** Which brace pair carried the marker text. */
export type MarkerForm = "output" | "statement";

/** Where a tag's docxtpl prefix says the tag belongs. `"none"` is a bare tag,
 *  placed by the consumer's leniency rules, and every output marker. */
export type MarkerPrefix = "none" | "paragraph" | "row";

const PREFIX_BY_TOKEN = {
  p: "paragraph",
  tr: "row",
} as const satisfies Record<"p" | "tr", MarkerPrefix>;

const readPrefix = (token: string | undefined): MarkerPrefix =>
  token === "p" || token === "tr" ? PREFIX_BY_TOKEN[token] : "none";

const TAG_RE = /^(?<tag>[\p{L}_][\p{L}\p{N}_]*)\b(?<rest>[\s\S]*)$/u;
const FOR_RE =
  /^(?<alias>[\p{L}_][\p{L}\p{N}_-]*)\s+in\s+(?<path>[\p{L}\p{N}_.-]+)$/u;
const CALL_RE = /^(?<name>[\p{L}_][\p{L}\p{N}_]*)\s*\(/u;

/** Classify a `{% ... %}` tag. */
const classifyStatement = (inner: string): MarkerMeta | null => {
  const match = TAG_RE.exec(inner);
  if (!match) {
    return null;
  }
  const tag = match.groups?.["tag"] ?? "";
  const rest = (match.groups?.["rest"] ?? "").trim();
  switch (tag) {
    case "if":
      return { kind: "if", expr: rest };
    case "elif":
      return { kind: "elif", expr: rest };
    case "else":
      return rest === "" ? { kind: "else" } : null;
    case "endif":
      return rest === "" ? { kind: "endif" } : null;
    case "endfor":
      return rest === "" ? { kind: "endfor" } : null;
    case "for": {
      const loop = FOR_RE.exec(rest);
      if (!loop) {
        return null;
      }
      return {
        kind: "for",
        alias: loop.groups?.["alias"] ?? "",
        path: loop.groups?.["path"] ?? "",
      };
    }
    default:
      return null;
  }
};

/** Classify a `{{ ... }}` output marker. */
const classifyOutput = (inner: string): MarkerMeta | null => {
  const call = CALL_RE.exec(inner);
  if (call) {
    const name = call.groups?.["name"] ?? "";
    if (!isFunctionName(name)) {
      return null;
    }
    const scanned = scanArguments(inner, inner.indexOf("("));
    if (scanned === null) {
      return null;
    }
    if (inner.slice(scanned.end).trim() !== "") {
      return null;
    }
    const positional = scanned.args.filter(
      (arg) => arg.kind === "positional" && typeof arg.value === "string",
    );
    if (positional.length !== scanned.args.length) {
      return null;
    }
    const [first, second] = positional.map((arg) => String(arg.value));
    if (first === undefined) {
      return null;
    }
    if (name === "clause") {
      return scanned.args.length <= 2
        ? { kind: "clause", name: first, version: second }
        : null;
    }
    if (scanned.args.length !== 1 || !isFieldPath(first)) {
      return null;
    }
    return name === "num"
      ? { kind: "num", key: first }
      : { kind: "ref", key: first };
  }

  const pipe = inner.indexOf("|");
  const head = (pipe === -1 ? inner : inner.slice(0, pipe)).trim();
  const tail = pipe === -1 ? "" : inner.slice(pipe);

  const loopMatch = /^loop\.(?<property>[\p{L}\p{N}_]+)$/u.exec(head);
  if (loopMatch) {
    const property = loopMatch.groups?.["property"] ?? "";
    return isLoopProperty(property) && tail === ""
      ? { kind: "loop", property }
      : null;
  }

  if (!FIELD_PATH_RE.test(head)) {
    return null;
  }
  if (tail === "") {
    return { kind: "placeholder", expr: head, filters: [] };
  }
  const chain = scanFilterChain(tail);
  if (chain === null || "unknownFilter" in chain) {
    return null;
  }
  return { kind: "placeholder", expr: head, filters: chain.filters };
};

/**
 * Classify the inner text of one marker. Returns `null` when the text is not a
 * recognized directive (so a recognizer can leave stray braces alone).
 */
export const classifyMarker = (
  innerRaw: string,
  form: MarkerForm = "output",
): MarkerMeta | null => {
  const inner = normalizeMarkerInner(innerRaw).trim();
  return form === "statement"
    ? classifyStatement(inner)
    : classifyOutput(inner);
};

// ── Scanner ──────────────────────────────────────────────

export type ScannedMarker = {
  /** Offset of the opening brace pair in the source text. */
  start: number;
  /** Offset just past the closing brace pair. */
  end: number;
  /** The full matched marker, e.g. `{% endfor %}`. */
  raw: string;
  /** The normalized, trimmed inner text. */
  inner: string;
  form: MarkerForm;
  /** The docxtpl placement prefix the author wrote. */
  prefix: MarkerPrefix;
  meta: MarkerMeta;
};

type MarkerSpan = {
  start: number;
  end: number;
  raw: string;
  inner: string;
  form: MarkerForm;
  prefix: MarkerPrefix;
};

/** Every marker-shaped span in `text`, in document order, before classification. */
const scanSpans = (text: string): MarkerSpan[] => {
  const re = markerPattern();
  const spans: MarkerSpan[] = [];
  let match = re.exec(text);
  while (match !== null) {
    const output = match.groups?.["output"];
    const statement = match.groups?.["statement"];
    const raw = match[0];
    const form: MarkerForm = output === undefined ? "statement" : "output";
    spans.push({
      start: match.index,
      end: match.index + raw.length,
      raw,
      inner: normalizeMarkerInner(output ?? statement ?? "").trim(),
      form,
      prefix: readPrefix(match.groups?.["prefix"]),
    });
    match = re.exec(text);
  }
  return spans;
};

/**
 * Find every recognized marker in `text`, in document order, with offsets and
 * classified metadata. Unrecognized spans are skipped.
 */
export const scanMarkers = (text: string): ScannedMarker[] => {
  const out: ScannedMarker[] = [];
  for (const span of scanSpans(text)) {
    const meta = classifyMarker(span.inner, span.form);
    if (meta) {
      out.push({ ...span, meta });
    }
  }
  return out;
};

/**
 * Rewrite every `{{ ... }}` output marker in `text` through `replace`, which
 * receives the whole marker and its raw inner text and returns the replacement.
 * Tags are left untouched. The single scan is the same one the classifier uses,
 * so a caller that rewrites marker text never needs its own regex.
 */
export const replaceOutputMarkers = (
  text: string,
  replace: (raw: string, inner: string) => string,
): string => {
  let out = "";
  let cursor = 0;
  for (const span of scanSpans(text)) {
    if (span.form !== "output") {
      continue;
    }
    out += text.slice(cursor, span.start) + replace(span.raw, span.inner);
    cursor = span.end;
  }
  return out + text.slice(cursor);
};

/**
 * The values-map key one marker substitutes from, or `null` when the marker is
 * not a substitution target (a tag, or a `loop.*` token the loop expander
 * resolves first). One function so the key discovery writes is the key the
 * patcher reads.
 */
export const substitutionKey = (meta: MarkerMeta): string | null => {
  switch (meta.kind) {
    case "placeholder":
      return meta.expr;
    case "clause":
      return meta.version === undefined
        ? `${CLAUSE_KEY_PREFIX}${meta.name}`
        : `${CLAUSE_KEY_PREFIX}${meta.name}:${meta.version}`;
    case "num":
    case "ref":
    case "loop":
    case "if":
    case "elif":
    case "else":
    case "endif":
    case "for":
    case "endfor":
      return null;
    default:
      return assertNever(meta);
  }
};

/** Namespace of the synthetic clause-slot key, kept out of the field-path
 *  charset so it can never collide with an author's path. */
const CLAUSE_KEY_PREFIX = "@clause:";

/** The values-map key for one clause slot. */
export const clauseSlotKey = (name: string, version?: string): string =>
  version === undefined
    ? `${CLAUSE_KEY_PREFIX}${name}`
    : `${CLAUSE_KEY_PREFIX}${name}:${version}`;

/** A marker-shaped span that classifies to nothing. */
export type InvalidMarker = {
  /** Offset of the opening brace pair in the source text. */
  start: number;
  /** Offset just past the closing brace pair. */
  end: number;
  /** The full matched span, e.g. `{{my field}}`. */
  raw: string;
  /** The normalized, trimmed inner text. */
  inner: string;
  form: MarkerForm;
};

/**
 * Find every marker-shaped span whose inner text is NOT a recognized
 * directive — near-misses an author clearly meant as markers but that every
 * recognizer skips, so they print literally at fill time. This is the exact
 * complement of {@link scanMarkers}: a span is in one list or the other.
 */
export const scanInvalidMarkers = (text: string): InvalidMarker[] => {
  const out: InvalidMarker[] = [];
  for (const { prefix: _prefix, ...span } of scanSpans(text)) {
    if (classifyMarker(span.inner, span.form) === null) {
      out.push(span);
    }
  }
  return out;
};

// ── Legacy dialect ───────────────────────────────────────

const LEGACY_BLOCK_RE =
  /^(?<token>#if|#elseif|#else|#each|\/if|\/each)\b(?<expr>[\s\S]*)$/u;
const LEGACY_CLAUSE_RE =
  /^@clause:(?<name>[^:}\s]+)(?::(?<version>[^}\s]+))?$/u;
const LEGACY_NUM_RE = /^@(?<fn>num|ref):(?<key>[\p{L}\p{N}_.-]+)$/u;

/** Singular of a plain-word path segment, for a generated loop alias. */
const singularize = (segment: string): string => {
  if (segment.endsWith("ies") && segment.length > 3) {
    return `${segment.slice(0, -3)}y`;
  }
  if (/(?:s|ss|sh|ch|x|z)es$/u.test(segment)) {
    return segment.slice(0, -2);
  }
  if (/[^s]s$/u.test(segment)) {
    return segment.slice(0, -1);
  }
  return segment;
};

/** The loop alias the codemod (and the legacy-marker message) generates for a
 *  `{{#each path}}`: the singular of the last plain-word segment, else `item`. */
export const legacyLoopAlias = (path: string): string => {
  const segment = path.split(".").at(-1) ?? "";
  if (!IDENTIFIER_RE.test(segment)) {
    return "item";
  }
  const alias = singularize(segment);
  return alias === "" || alias === segment ? "item" : alias;
};

/** Translate an old-dialect condition expression to the Jinja surface:
 *  `!a` becomes `not a`, `a contains "x"` becomes `"x" in a`. */
export const translateLegacyExpression = (expr: string): string =>
  expr
    .replace(
      /(?<path>[\p{L}\p{N}_.-]+)\s+contains\s+(?<value>"[^"]*"|[\p{L}\p{N}_.-]+)/gu,
      (_m, path: string, value: string) =>
        `${value.startsWith('"') ? value : `"${value}"`} in ${path}`,
    )
    .replace(/!(?!=)\s*/gu, "not ");

/**
 * The Jinja marker that replaces one old-dialect marker's inner text, or
 * `null` when the text is not old-dialect. Shared by the rejection message and
 * the codemod, so the fix an author is told to make is the fix the script
 * would have made.
 */
export const legacyMarkerReplacement = (innerRaw: string): string | null => {
  const inner = normalizeMarkerInner(innerRaw).trim();
  const block = LEGACY_BLOCK_RE.exec(inner);
  if (block) {
    const token = block.groups?.["token"] ?? "";
    const expr = translateLegacyExpression(
      (block.groups?.["expr"] ?? "").trim(),
    );
    switch (token) {
      case "#if":
        return `{% if ${expr} %}`;
      case "#elseif":
        return `{% elif ${expr} %}`;
      case "#else":
        return "{% else %}";
      case "/if":
        return "{% endif %}";
      case "#each":
        return `{% for ${legacyLoopAlias(expr)} in ${expr} %}`;
      case "/each":
        return "{% endfor %}";
      default:
        return null;
    }
  }
  const clause = LEGACY_CLAUSE_RE.exec(inner);
  if (clause) {
    const name = clause.groups?.["name"] ?? "";
    const version = clause.groups?.["version"];
    return version === undefined
      ? `{{ clause("${name}") }}`
      : `{{ clause("${name}", "${version}") }}`;
  }
  const numbering = LEGACY_NUM_RE.exec(inner);
  if (numbering) {
    return `{{ ${numbering.groups?.["fn"] ?? ""}("${numbering.groups?.["key"] ?? ""}") }}`;
  }
  if (inner === "@index") {
    return "{{ loop.index }}";
  }
  if (inner === "@count") {
    return "{{ loop.length }}";
  }
  return null;
};

// ── Defect classification ────────────────────────────────

/**
 * Why a marker-shaped span misses the grammar in a way that names the
 * authoring mistake rather than merely failing to classify. Consumers derive
 * their own warning codes from {@link MARKER_DEFECT_KINDS} so the two never
 * drift.
 */
export type MarkerDefectKind =
  | "legacy_marker"
  | "unsupported_tag"
  | "unknown_filter"
  | "python_expression"
  | "bracket_index";

const MARKER_DEFECT_KIND_VALUES = [
  "legacy_marker",
  "unsupported_tag",
  "unknown_filter",
  "python_expression",
  "bracket_index",
] as const satisfies readonly MarkerDefectKind[];

type MissingMarkerDefectKind = Exclude<
  MarkerDefectKind,
  (typeof MARKER_DEFECT_KIND_VALUES)[number]
>;

true satisfies MissingMarkerDefectKind extends never ? true : never;

export const MARKER_DEFECT_KINDS = MARKER_DEFECT_KIND_VALUES;

/** One diagnosis of a rejected span: the kind plus the construct to quote. */
export type MarkerDefect = {
  kind: MarkerDefectKind;
  /** The construct the author wrote that the grammar refuses. */
  construct: string;
  /** The Jinja that replaces it, when the mistake has one exact fix. */
  replacement?: string;
};

/** Bracket indexing (`items[0].name`), which no directive kind admits. */
const BRACKET_INDEX_RE = /[[\]]/u;
/** A legacy directive sigil at the head of an output marker. */
const LEGACY_SHAPE_RE = /^[#/@]/u;
/**
 * Arithmetic, a call, a quoted string or a Python literal inside `{{ }}`. A
 * span that merely holds a space (`{{my field}}`) is a mistyped path, not an
 * expression, and stays undiagnosed so the check reports it as an unreadable
 * marker rather than guessing at Python.
 */
const PYTHON_SHAPE_RE = /["'()+*/%]|\bNone\b|\bTrue\b|\bFalse\b/u;

/**
 * Name the authoring mistake behind one marker's inner text, or `null` when
 * the text is a recognized directive ({@link classifyMarker} accepts it) or an
 * unrecognizable span with no specific diagnosis (`{{my field}}`).
 */
export const classifyMarkerDefect = (
  innerRaw: string,
  form: MarkerForm = "output",
): MarkerDefect | null => {
  const inner = normalizeMarkerInner(innerRaw).trim();
  if (classifyMarker(inner, form) !== null) {
    return null;
  }

  if (form === "statement") {
    const tag = TAG_RE.exec(inner)?.groups?.["tag"];
    if (tag === undefined) {
      return null;
    }
    const legacy = legacyMarkerReplacement(inner);
    if (legacy !== null) {
      return { kind: "legacy_marker", construct: inner, replacement: legacy };
    }
    return { kind: "unsupported_tag", construct: tag };
  }

  const legacy = legacyMarkerReplacement(inner);
  if (legacy !== null) {
    return { kind: "legacy_marker", construct: inner, replacement: legacy };
  }
  if (LEGACY_SHAPE_RE.test(inner)) {
    return { kind: "legacy_marker", construct: inner };
  }
  if (BRACKET_INDEX_RE.test(inner)) {
    return { kind: "bracket_index", construct: inner };
  }

  const pipe = inner.indexOf("|");
  if (pipe !== -1) {
    const chain = scanFilterChain(inner.slice(pipe));
    if (chain !== null && "unknownFilter" in chain) {
      return { kind: "unknown_filter", construct: chain.unknownFilter };
    }
  }

  const call = CALL_RE.exec(inner);
  if (call) {
    const name = call.groups?.["name"] ?? "";
    if (!isFunctionName(name)) {
      return { kind: "python_expression", construct: `${name}(...)` };
    }
    return { kind: "python_expression", construct: inner };
  }

  const head = (pipe === -1 ? inner : inner.slice(0, pipe)).trim();
  if (head !== "" && !FIELD_PATH_RE.test(head) && PYTHON_SHAPE_RE.test(head)) {
    return { kind: "python_expression", construct: head };
  }
  return null;
};

/** Exhaustiveness guard — pass the discriminant in a `switch` default branch. */
export const assertNever = (value: never): never =>
  panic(`Unhandled template directive: ${JSON.stringify(value)}`);
