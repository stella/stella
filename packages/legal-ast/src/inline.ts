// parser-output-unchanged: [cz-ns] this decision reader constructs no numeric superscript inlines; canonical text is unchanged.
// parser-output-unchanged: [cz-nss] this decision reader constructs no numeric superscript inlines; canonical text is unchanged.
// parser-output-unchanged: [cz-us] this decision reader constructs no numeric superscript inlines; canonical text is unchanged.
// parser-output-unchanged: [cz-regional] this decision reader constructs no numeric superscript inlines; canonical text is unchanged.
// parser-output-unchanged: [sk-courts] this decision reader constructs no numeric superscript inlines; canonical text is unchanged.
// parser-output-unchanged: [sk-us] this decision reader constructs no numeric superscript inlines; canonical text is unchanged.
// parser-output-unchanged: [at-findok] this decision reader constructs no numeric superscript inlines; canonical text is unchanged.
// parser-output-unchanged: [hu-bhgy] this decision reader constructs no numeric superscript inlines; canonical text is unchanged.
// parser-output-unchanged: [uk-fcl] this decision reader constructs no numeric superscript inlines; canonical text is unchanged.
// parser-output-unchanged: [pl-kis] this decision reader constructs no numeric superscript inlines; canonical text is unchanged.
// parser-output-unchanged: [pl-uokik] this decision reader constructs no numeric superscript inlines; canonical text is unchanged.
// parser-output-unchanged: [us-courtlistener] this decision reader constructs no numeric superscript inlines; canonical text is unchanged.
// parser-output-unchanged: Citation tuples state their existing one-item minimum for schema publication; accepted values are identical.
// parser-output-unchanged: Legislation citations are a new inline variant that no decision parser writes; existing citations validate as before.
import * as v from "valibot";

import {
  DECISION_IDENTIFIER_MAX_COUNT,
  decisionIdentifierSchema,
  reporterCitationIdentifierSchema,
} from "./decision-identifier.js";
import type {
  DecisionIdentifiers,
  ReporterCitationIdentifier,
} from "./decision-identifier.js";

export type InlineText = {
  type: "text";
  text: string;
  /** True when this text was anonymized by the publishing authority. */
  anonymized?: true | undefined;
};

export type InlineBold = { type: "bold"; children: Inline[] };
export type InlineItalic = { type: "italic"; children: Inline[] };
export type InlineUnderline = { type: "underline"; children: Inline[] };
export type InlineSuperscript = { type: "superscript"; children: Inline[] };
export type InlineSubscript = { type: "subscript"; children: Inline[] };
export type InlineLink = { type: "link"; href: string; children: Inline[] };
export type InlineLineBreak = { type: "line-break" };

/** Why the text alone does not settle which decision a reference names. */
export const CITATION_UNRESOLVED_REASONS = [
  "missing-antecedent",
  "ambiguous-antecedent",
  "ambiguous-reporter",
  "authority-barrier",
  "scope-unknown",
  "conflicting-parallels",
] as const;

export type CitationUnresolvedReason =
  (typeof CITATION_UNRESOLVED_REASONS)[number];

/**
 * Which decision a printed reference names, as read from the text alone.
 *
 * `identified` is the reference's own identity, never a database match. An
 * `unresolved` reference says why the text did not settle it, and carries no
 * identifiers, so a reader never links it on a guess.
 */
export type InlineCitationTarget =
  | { status: "identified"; identifiers: DecisionIdentifiers }
  | { status: "unresolved"; reason: CitationUnresolvedReason };

/**
 * One place a pin points at. Endpoints are the digits as printed: a range
 * printed `495–97` ends at `97`, not at a page worked out from it.
 */
export type InlineCitationPinPart = {
  kind: "page" | "paragraph" | "footnote";
  start: string;
  end?: string | undefined;
};

/** Where inside the cited decision a reference points; never its identity. */
export type InlineCitationPin = {
  raw: string;
  parts: readonly [InlineCitationPinPart, ...InlineCitationPinPart[]];
  /** The reporter the pages belong to, when the text establishes one. */
  reporter?: ReporterCitationIdentifier | undefined;
};

/**
 * The legislation series an act is numbered in. EU acts share one series per
 * form, numbered within a year; a Czech act is numbered within its year in
 * the Collection of Laws (Sbírka zákonů) whatever its form.
 */
export const LEGISLATION_SERIES = [
  "eu-regulation",
  "eu-directive",
  "eu-decision",
  "cz-sb",
] as const;

export type LegislationSeries = (typeof LEGISLATION_SERIES)[number];

/**
 * Which act a printed reference names, as read from the text or its link.
 *
 * Year and number are the act's own numbering, never a database id, so a
 * reader resolves them against the legislation corpus rather than trusting a
 * guess. `appliedVersion` is the date of the consolidated version the
 * reference names, and is present only when the reference states one (a
 * consolidated CELEX, an ELI or a Collection link carrying a date); a bare
 * act number says nothing about which version the author read.
 */
export type InlineLegislationTarget = {
  status: "legislation";
  series: LegislationSeries;
  year: number;
  number: number;
  appliedVersion?: { date: string } | undefined;
};

type InlineCitationFields = {
  type: "citation";
  cite: string;
  href?: string | undefined;
  children: Inline[];
};

/**
 * A reference to another authority, as the publisher printed it.
 *
 * `cite` is the printed citation itself, kept out of the character axis
 * exactly like a page anchor's label: the words a reader sees are the
 * children, and the citator reads `cite` from the rendered element. A
 * `href` is present only when the publisher linked the reference.
 */
export type InlineDecisionCitation = InlineCitationFields & {
  target?: InlineCitationTarget | undefined;
  pin?: InlineCitationPin | undefined;
};

/**
 * A reference to an act. It carries no `pin`: a pin locates pages and
 * paragraphs of a decision, and an act's provisions are not either.
 */
export type InlineLegislationCitation = InlineCitationFields & {
  target: InlineLegislationTarget;
  pin?: undefined;
};

export type InlineCitation = InlineDecisionCitation | InlineLegislationCitation;

/**
 * A reporter page boundary at this exact point in the text. Contributes
 * ZERO characters to the plain-text axis: the published page break is
 * typography, not content — it may fall mid-word, and the word must stay
 * whole for search, offsets and copying. Renderers show the label as
 * out-of-band chrome (a margin marker, a tick).
 */
export type InlinePageAnchor = {
  type: "page-anchor";
  /** The page number as printed ("495"). */
  label: string;
  /** Link to the official page scan, when one exists. */
  href?: string | undefined;
};

export type Inline =
  | InlineText
  | InlineBold
  | InlineItalic
  | InlineUnderline
  | InlineSuperscript
  | InlineSubscript
  | InlineLink
  | InlineCitation
  | InlineLineBreak
  | InlinePageAnchor;

/** The inline kinds that nest children. */
export type InlineWithChildren = Extract<Inline, { children: Inline[] }>;

/**
 * Whether an inline kind nests children, per kind.
 *
 * Total over `Inline["type"]`, so a kind added to the union without an
 * entry here is a type error rather than a container silently read as a
 * leaf — which would drop its whole subtree from every text projection.
 */
const INLINE_NESTS_CHILDREN = {
  text: false,
  "line-break": false,
  "page-anchor": false,
  bold: true,
  italic: true,
  underline: true,
  superscript: true,
  subscript: true,
  link: true,
  citation: true,
} as const satisfies Record<Inline["type"], boolean>;

export const hasInlineChildren = (
  inline: Inline,
): inline is InlineWithChildren => INLINE_NESTS_CHILDREN[inline.type];

/** Whether a stored `type` string names an inline kind this reader knows. */
export const isKnownInlineType = (type: string): boolean =>
  Object.hasOwn(INLINE_NESTS_CHILDREN, type);

/**
 * Declared once and shared by every container branch below: each `v.array`
 * plus `v.lazy` pair is a separate recursive instantiation, and the union
 * has enough container kinds for the duplication to cost real checker time.
 */
const inlineChildrenSchema = v.array(v.lazy(() => inlineSchema));

export const CITATION_PIN_RAW_MAX_LENGTH = 128;
export const CITATION_PIN_MAX_PARTS = 8;
const CITATION_PIN_ENDPOINT_MAX_LENGTH = 16;

const citationTargetSchema: v.GenericSchema<InlineCitationTarget> = v.variant(
  "status",
  [
    v.strictObject({
      status: v.literal("identified"),
      identifiers: v.pipe(
        v.tupleWithRest([decisionIdentifierSchema], decisionIdentifierSchema),
        v.minLength(1),
        v.maxLength(DECISION_IDENTIFIER_MAX_COUNT),
      ),
    }),
    v.strictObject({
      status: v.literal("unresolved"),
      reason: v.picklist(CITATION_UNRESOLVED_REASONS),
    }),
  ],
);

const pinEndpointSchema = v.pipe(
  v.string(),
  v.maxLength(CITATION_PIN_ENDPOINT_MAX_LENGTH),
  v.regex(/^\*?\d+$/u),
);

const citationPinPartSchema = v.strictObject({
  kind: v.picklist(["page", "paragraph", "footnote"]),
  start: pinEndpointSchema,
  end: v.optional(pinEndpointSchema),
});

const citationPinSchema: v.GenericSchema<InlineCitationPin> = v.strictObject({
  raw: v.pipe(
    v.string(),
    v.nonEmpty(),
    v.maxLength(CITATION_PIN_RAW_MAX_LENGTH),
  ),
  parts: v.pipe(
    v.tupleWithRest([citationPinPartSchema], citationPinPartSchema),
    v.minLength(1),
    v.maxLength(CITATION_PIN_MAX_PARTS),
  ),
  reporter: v.optional(reporterCitationIdentifierSchema),
});

/**
 * The citation fields both readers share. Strict inside the structured
 * fields, so a malformed target or pin fails the parse instead of being
 * stripped; the outer object keeps the tolerant shape every inline has.
 */
const citationFieldEntries = {
  type: v.literal("citation"),
  cite: v.pipe(v.string(), v.nonEmpty()),
  href: v.optional(v.string()),
  target: v.optional(citationTargetSchema),
  pin: v.optional(citationPinSchema),
};

const actNumberSchema = v.pipe(v.number(), v.integer(), v.minValue(1));

const legislationTargetSchema: v.GenericSchema<InlineLegislationTarget> =
  v.strictObject({
    status: v.literal("legislation"),
    series: v.picklist(LEGISLATION_SERIES),
    year: v.pipe(v.number(), v.integer(), v.minValue(1000), v.maxValue(9999)),
    number: actNumberSchema,
    appliedVersion: v.optional(
      v.strictObject({
        date: v.pipe(v.string(), v.regex(/^\d{4}-\d{2}-\d{2}$/u)),
      }),
    ),
  });

/**
 * A legislation citation's fields: its own variant entry rather than a
 * fourth decision target, because it declares no `pin`. Like every inline
 * object, the reader drops a key it does not declare, so a pin never reaches
 * a parsed legislation citation.
 */
const legislationCitationFieldEntries = {
  type: v.literal("citation"),
  cite: v.pipe(v.string(), v.nonEmpty()),
  href: v.optional(v.string()),
  target: legislationTargetSchema,
};

export const inlineSchema: v.GenericSchema<Inline> = v.variant("type", [
  v.object({
    type: v.literal("text"),
    text: v.string(),
    anonymized: v.optional(v.literal(true)),
  }),
  v.object({ type: v.literal("bold"), children: inlineChildrenSchema }),
  v.object({ type: v.literal("italic"), children: inlineChildrenSchema }),
  v.object({ type: v.literal("underline"), children: inlineChildrenSchema }),
  v.object({ type: v.literal("superscript"), children: inlineChildrenSchema }),
  v.object({ type: v.literal("subscript"), children: inlineChildrenSchema }),
  v.object({
    type: v.literal("link"),
    href: v.string(),
    children: inlineChildrenSchema,
  }),
  v.object({ ...citationFieldEntries, children: inlineChildrenSchema }),
  v.object({
    ...legislationCitationFieldEntries,
    children: inlineChildrenSchema,
  }),
  v.object({ type: v.literal("line-break") }),
  v.object({
    type: v.literal("page-anchor"),
    label: v.string(),
    href: v.optional(v.string()),
  }),
]);

const inlineArraySchema = v.array(v.lazy(() => inlineSchema));

export const isInlineArray = (val: unknown): val is Inline[] =>
  v.is(inlineArraySchema, val);

export const isInline = (val: unknown): val is Inline =>
  v.is(inlineSchema, val);

/** The rendered axis keeps offsets; search text marks numeric superscripts. */
export const flattenInlineText = (
  inlines: readonly Inline[],
  projection: "search" | "rendered" = "search",
): string => {
  const parts: string[] = [];

  for (const inline of inlines) {
    if (inline.type === "text") {
      parts.push(inline.text);
      continue;
    }

    if (inline.type === "line-break") {
      parts.push("\n");
      continue;
    }

    if (inline.type === "page-anchor") {
      // Typography, not content: zero characters on the text axis.
      continue;
    }

    const text = flattenInlineText(inline.children, projection);
    // A numeric index names a different provision from the concatenated
    // number. Caret notation survives compatibility normalization in search.
    parts.push(
      inline.type === "superscript" && projection === "search"
        ? text.replace(/^(\s*)(\d+)(\s*)$/u, "$1^$2$3")
        : text,
    );
  }

  return parts.join("");
};

/**
 * An inline the persisted reader could not recognise, once degraded.
 * `null` means it carried nothing to keep and is dropped.
 */
type DegradedInline = Inline | null;

/**
 * The persisted counterpart of `inlineSchema`, tolerant of an inline
 * kind this reader does not declare.
 *
 * Same doctrine as a block role: a stored kind this reader does not know
 * is either a newer writer's or a row written past the ingestion
 * boundary, and it names presentation, not content. Failing the whole
 * document over it would take the text down with the presentation, so
 * the reader keeps the characters and loses only the kind — an unknown
 * container collapses to the flattened text of its (recursively read)
 * children, an unknown leaf carrying a string `text` collapses to that
 * text, and anything with neither is dropped. The canonical
 * `inlineSchema` stays strict, so a writer still cannot persist a kind
 * it does not declare, and `persistedAstDegradations` reports what was
 * degraded so a row needing repair stays visible.
 *
 * A kind this reader DOES declare is not tolerated: a malformed `bold`
 * is a defect in what was written, and the parse must still fail.
 */
const degradedInlineSchema: v.GenericSchema<unknown, DegradedInline> = v.pipe(
  v.object({
    type: v.pipe(
      v.string(),
      v.check((type) => !isKnownInlineType(type)),
    ),
    text: v.optional(v.unknown()),
    children: v.optional(v.unknown()),
  }),
  v.transform(({ children, text }): DegradedInline => {
    const nested = v.safeParse(persistedInlineArraySchema, children);
    if (nested.success) {
      return { type: "text", text: flattenInlineText(nested.output) };
    }
    return typeof text === "string" ? { type: "text", text } : null;
  }),
);

const persistedInlineSchema: v.GenericSchema<unknown, DegradedInline> = v.union(
  [
    v.variant("type", [
      v.object({
        type: v.literal("text"),
        text: v.string(),
        anonymized: v.optional(v.literal(true)),
      }),
      v.object({
        type: v.literal("bold"),
        children: v.lazy(() => persistedInlineArraySchema),
      }),
      v.object({
        type: v.literal("italic"),
        children: v.lazy(() => persistedInlineArraySchema),
      }),
      v.object({
        type: v.literal("underline"),
        children: v.lazy(() => persistedInlineArraySchema),
      }),
      v.object({
        type: v.literal("superscript"),
        children: v.lazy(() => persistedInlineArraySchema),
      }),
      v.object({
        type: v.literal("subscript"),
        children: v.lazy(() => persistedInlineArraySchema),
      }),
      v.object({
        type: v.literal("link"),
        href: v.string(),
        children: v.lazy(() => persistedInlineArraySchema),
      }),
      v.object({
        ...citationFieldEntries,
        children: v.lazy(() => persistedInlineArraySchema),
      }),
      v.object({
        ...legislationCitationFieldEntries,
        children: v.lazy(() => persistedInlineArraySchema),
      }),
      v.object({ type: v.literal("line-break") }),
      v.object({
        type: v.literal("page-anchor"),
        label: v.string(),
        href: v.optional(v.string()),
      }),
    ]),
    degradedInlineSchema,
  ],
);

/**
 * An inline run read from storage, with every unreadable kind degraded
 * and every empty degradation dropped.
 */
export const persistedInlineArraySchema: v.GenericSchema<unknown, Inline[]> =
  v.pipe(
    v.array(persistedInlineSchema),
    v.transform((inlines) => inlines.filter((inline) => inline !== null)),
  );

/**
 * Every `type` string a raw stored inline run carries, in document order,
 * including nested ones.
 *
 * Reads the raw value rather than the parsed run, because parsing is
 * where an unrecognised kind stops being visible.
 */
const rawInlineShape = v.object({
  type: v.string(),
  children: v.optional(v.unknown()),
});

export const rawInlineTypes = (raw: unknown): string[] => {
  const nodes = v.safeParse(v.array(v.unknown()), raw);
  if (!nodes.success) {
    return [];
  }
  const types: string[] = [];
  for (const candidate of nodes.output) {
    const node = v.safeParse(rawInlineShape, candidate);
    if (!node.success) {
      continue;
    }
    types.push(node.output.type, ...rawInlineTypes(node.output.children));
  }
  return types;
};
