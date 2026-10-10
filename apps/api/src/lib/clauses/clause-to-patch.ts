import { panic, Result } from "better-result";
import type * as slimdom from "slimdom";

import { CLAUSE_DIRECTIVES_INVALID_CODE } from "@stll/api-contract";
import {
  scanMarkers,
  type NamedCondition,
  type LoopProperty,
} from "@stll/template-conditions";

import {
  createDirectiveProcessingContext,
  processBlockDirectives,
  readConditionRawValues,
} from "@/api/lib/docx/block-directives";
import {
  discoverTemplate,
  locateFieldMarkers,
} from "@/api/lib/docx/discover-template";
import { processInlineConditions } from "@/api/lib/docx/inline-conditions";
import { paragraphText, W_NS } from "@/api/lib/docx/ooxml";
import {
  collectRenderedFieldTokens,
  createFieldMarkerTable,
  scopeInlineFieldTokens,
  swapFieldMarkersForTokens,
} from "@/api/lib/docx/rendered-field-markers";
import type { RenderedFieldOccurrence } from "@/api/lib/docx/rendered-field-markers";
import {
  paragraphSpanText,
  patchParagraphPlaceholders,
  replaceParagraphTextRanges,
} from "@/api/lib/docx/rich-patch";
import type {
  ClauseProvenance,
  EnclosingScope,
  TemplateData,
  RichRun,
  RichPatchValue,
} from "@/api/lib/docx/types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { ScannedFile } from "@/api/lib/file-scan/scanned-file";

import {
  clauseDirectiveContainer,
  validateClauseBodyDirectives,
} from "./clause-directives";
import type { ClauseListKind, ClauseParagraph, ClauseBody } from "./types";

const NESTED_INDENT = "    ";

// NOTE: The rich-patch DOCX layer fills a flat run of `w:p` paragraphs cloned
// from the host marker's pPr; it has no path to emit real `w:numPr` numbering
// without injecting numbering.xml definitions and threading a numId through
// every paragraph-producing branch. Rather than destabilize that fill path (or
// silently drop the list), list items are rendered as ordinary paragraphs whose
// first run carries a textual marker ("• " for bullets; "1." / "a." / "i." by
// level for ordered lists) plus indentation. This mirrors the path already
// flattening heading styles to plain runs, so the list text survives injection
// readably. See clause-editor for the structured model that the read view and
// editor render as true nested <ul>/<ol>.
const ROMAN = [
  "i",
  "ii",
  "iii",
  "iv",
  "v",
  "vi",
  "vii",
  "viii",
  "ix",
  "x",
] as const;

const ASCII_LOWER = "abcdefghijklmnopqrstuvwxyz";

const orderedLabel = (level: number, ordinal: number): string => {
  // 1-based ordinal; cycle marker style by depth: 1. → a. → i. → 1. …
  const style = level % 3;
  if (style === 1) {
    // charAt always returns a string — no number | undefined to guard (unlike
    // codePointAt, or indexed access under noUncheckedIndexedAccess).
    const letter = ASCII_LOWER.charAt((ordinal - 1) % 26);
    return `${letter}.`;
  }
  if (style === 2) {
    return `${ROMAN[(ordinal - 1) % ROMAN.length] ?? String(ordinal)}.`;
  }
  return `${ordinal}.`;
};

const listMarker = (
  kind: ClauseListKind,
  level: number,
  ordinal: number,
): string => {
  const indent = NESTED_INDENT.repeat(level);
  if (kind === "bullet") {
    return `${indent}• `;
  }
  return `${indent}${orderedLabel(level, ordinal)} `;
};

const prefixRuns = (runs: RichRun[], prefix: string): RichRun[] => {
  const [first, ...rest] = runs;
  if (!first) {
    return [{ text: prefix }];
  }
  return [{ ...first, text: `${prefix}${first.text}` }, ...rest];
};

const paragraphRuns = (p: ClauseParagraph): RichRun[] =>
  p.runs ?? [{ text: p.text }];

/**
 * Convert a ClauseBody into a RichPatchValue suitable for DOCX template
 * filling. Directives have already been resolved; list items are flattened to
 * marker-prefixed paragraphs (see NOTE above); every other paragraph maps to
 * its runs.
 */
const resolvedBodyToRichPatch = (body: ClauseBody): RichPatchValue => {
  // Per-level ordinal counters for ordered lists; reset when the list breaks
  // (a non-list paragraph) or a level is left and re-entered.
  const counters = new Map<number, number>();

  const paragraphs: { runs: RichRun[] }[] = [];
  for (const p of body) {
    if (!p.listKind) {
      counters.clear();
      paragraphs.push({ runs: paragraphRuns(p) });
      continue;
    }

    const level = Math.max(0, p.listLevel ?? 0);
    // Leaving a deeper level invalidates its counter for a fresh restart.
    for (const key of counters.keys()) {
      if (key > level) {
        counters.delete(key);
      }
    }
    const ordinal = (counters.get(level) ?? 0) + 1;
    counters.set(level, ordinal);

    paragraphs.push({
      runs: prefixRuns(
        paragraphRuns(p),
        listMarker(p.listKind, level, ordinal),
      ),
    });
  }

  return { paragraphs };
};

type DiscoverTemplateWithClausesOptions = {
  file: ScannedFile;
  bodies: Record<string, ClauseBody>;
  clauses: Record<string, ClauseProvenance>;
};

export const discoverTemplateWithClauses = async ({
  file,
  bodies,
  clauses,
}: DiscoverTemplateWithClausesOptions) =>
  discoverTemplate(
    file,
    Object.entries(bodies)
      .filter(([, body]) => Result.isOk(validateClauseBodyDirectives(body)))
      .map(([slotKey, body]) => ({
        container: clauseDirectiveContainer(body),
        clause:
          clauses[slotKey] ?? panic(`Missing clause provenance for ${slotKey}`),
      })),
  );

export type ClauseFillContext = {
  values: TemplateData;
  slotKey: string;
  namedConditions?: NamedCondition[] | undefined;
  source?: "stored" | "authored" | undefined;
  /** The template loop iteration the slot renders in, whose counters the
   *  body's own `{{ loop.* }}` markers print, as a marker written inline in
   *  that loop body would. */
  enclosingLoop?: Record<LoopProperty, number | boolean> | undefined;
};

const hasTemplateMarkers = (body: ClauseBody): boolean =>
  body.some((paragraph) => {
    const text = paragraph.isDirective
      ? paragraph.text
      : paragraphRuns(paragraph)
          .map(({ text: runText }) => runText)
          .join("");
    return text.includes("{{") || text.includes("{%");
  });

type ClauseEvaluationOptions = Pick<
  ClauseFillContext,
  "values" | "namedConditions"
> & {
  /** Sees the body's container before its directives are evaluated. */
  prepare?:
    | ((container: slimdom.Element) => Result<void, HandlerError<422>>)
    | undefined;
  scopeInlineText?: ReturnType<
    typeof createDirectiveProcessingContext
  >["scopeInlineText"];
};

/** The body's directives evaluated against `values`: one pass shared by the
 *  rendering and by reading which of its markers render. */
const evaluateClauseDirectives = (
  body: ClauseBody,
  {
    values,
    namedConditions,
    prepare,
    scopeInlineText,
  }: ClauseEvaluationOptions,
) => {
  const container = clauseDirectiveContainer(body);
  const prepared = prepare?.(container);
  if (prepared !== undefined && Result.isError(prepared)) {
    return Result.err(prepared.error);
  }
  const conditionValues = readConditionRawValues(values);
  const processingContext = createDirectiveProcessingContext();
  processingContext.scopeInlineText = scopeInlineText;
  const { patchValues, errors } = processBlockDirectives(container, values, {
    conditionValues,
    namedConditions,
    processingContext,
  });
  const inlineErrors = processInlineConditions(
    container,
    conditionValues === undefined ? values : { ...values, ...conditionValues },
    namedConditions,
    { processingContext },
  );
  return Result.ok({
    container,
    patchValues,
    errors: [...errors, ...inlineErrors],
    loopScopes: processingContext.inlineDataByParagraph,
  });
};

type RenderedClauseFieldOptions = Pick<
  ClauseFillContext,
  "values" | "namedConditions"
> & {
  /** Where the slot renders the body, from the template's discovery. */
  slotScope: EnclosingScope | null | undefined;
};

/**
 * The value markers a clause body renders where its slot renders it with
 * `values` (the slot's document values or loop iteration). A body whose
 * directives do not validate renders as literal text, so none of its markers
 * render as fields.
 */
export const renderedClauseFieldMarkers = (
  body: ClauseBody,
  { values, namedConditions, slotScope }: RenderedClauseFieldOptions,
): Result<RenderedFieldOccurrence[], HandlerError<422>> => {
  if (
    Result.isError(validateClauseBodyDirectives(body)) ||
    !hasTemplateMarkers(body)
  ) {
    return Result.ok([]);
  }
  const table = createFieldMarkerTable(
    body.map((paragraph) =>
      paragraph.isDirective
        ? paragraph.text
        : paragraphRuns(paragraph)
            .map(({ text }) => text)
            .join(""),
    ),
  );
  const evaluated = evaluateClauseDirectives(body, {
    values,
    namedConditions,
    scopeInlineText: (options) => scopeInlineFieldTokens(table, options),
    prepare: (prepared) =>
      swapFieldMarkersForTokens(
        locateFieldMarkers(prepared, { scope: slotScope }).fieldMarkers,
        table,
      ),
  });
  if (Result.isError(evaluated)) {
    return evaluated;
  }
  const { container, errors, loopScopes } = evaluated.value;
  if (errors.length > 0) {
    return Result.ok([]);
  }
  const rendered: RenderedFieldOccurrence[] = [];
  collectRenderedFieldTokens(container, loopScopes, table, rendered);
  for (const occurrence of rendered) {
    occurrence.scope ??= values;
  }
  return Result.ok(rendered);
};

/** Resolve the stored body with the template engine before list labels or rich
 * patches are constructed. Synthetic loop keys stay local to this clause. */
export const clauseBodyToRichPatch = (
  body: ClauseBody,
  {
    values,
    slotKey,
    namedConditions,
    source,
    enclosingLoop,
  }: ClauseFillContext,
): Result<RichPatchValue, HandlerError<422>> => {
  const structureError = (
    errors: { message: string; paragraphIndex: number; directive: string }[],
  ) =>
    Result.err(
      new HandlerError({
        status: 422,
        code: CLAUSE_DIRECTIVES_INVALID_CODE,
        retryable: false,
        message: `Clause slot ${slotKey} has invalid directives.`,
        issues: errors.map(({ message, paragraphIndex }) => ({
          path: `${slotKey}.${paragraphIndex}`,
          message,
        })),
      }),
    );

  const validation = validateClauseBodyDirectives(body);
  if (Result.isError(validation)) {
    return source === "stored"
      ? Result.ok(resolvedBodyToRichPatch(body))
      : Result.err(validation.error);
  }
  if (!hasTemplateMarkers(body)) {
    return Result.ok(resolvedBodyToRichPatch(body));
  }

  const evaluated = evaluateClauseDirectives(body, {
    values,
    namedConditions,
  });
  if (Result.isError(evaluated)) {
    return evaluated;
  }
  const { container, patchValues, errors } = evaluated.value;
  if (errors.length > 0) {
    return structureError(errors);
  }

  // Insertion does not recursively patch a rich value's contents. Resolve the
  // loop engine's generated keys here, never in the template's global key map.
  for (const paragraph of [...container.getElementsByTagNameNS(W_NS, "p")]) {
    // Clause-local loops have resolved their counters; surviving tokens bind
    // to the template iteration that contains this clause occurrence.
    if (enclosingLoop !== undefined) {
      const ranges = scanMarkers(paragraphSpanText(paragraph)).flatMap(
        ({ meta, start, end }) =>
          meta.kind === "loop"
            ? [{ start, end, value: String(enclosingLoop[meta.property]) }]
            : [],
      );
      replaceParagraphTextRanges(paragraph, ranges);
    }
    patchParagraphPlaceholders(paragraph, patchValues);
  }
  const resolved: ClauseBody = [];
  for (const paragraph of container.getElementsByTagNameNS(W_NS, "p")) {
    const originIndex = paragraph
      .getElementsByTagNameNS(W_NS, "pPr")
      .at(0)
      ?.getAttribute("clause-origin");
    const origin =
      originIndex === null || originIndex === undefined
        ? undefined
        : body.at(Number(originIndex));
    if (!origin) {
      panic("Clause paragraph lost its origin during directive resolution");
    }
    const runs = [...paragraph.getElementsByTagNameNS(W_NS, "r")].flatMap(
      (run) => {
        const bold = run.getElementsByTagNameNS(W_NS, "b").at(0);
        const italic = run.getElementsByTagNameNS(W_NS, "i").at(0);
        const result: RichRun = {
          text: [...run.getElementsByTagNameNS(W_NS, "t")]
            .map((text) => text.textContent)
            .join(""),
        };
        if (bold !== undefined) {
          result.bold = bold.getAttributeNS(W_NS, "val") !== "0";
        }
        if (italic !== undefined) {
          result.italic = italic.getAttributeNS(W_NS, "val") !== "0";
        }
        return result.text === "" ? [] : [result];
      },
    );
    resolved.push({
      text: paragraphText(paragraph),
      runs,
      ...(origin.style === undefined ? {} : { style: origin.style }),
      ...(origin.level === undefined ? {} : { level: origin.level }),
      ...(origin.listKind === undefined ? {} : { listKind: origin.listKind }),
      ...(origin.listLevel === undefined
        ? {}
        : { listLevel: origin.listLevel }),
    });
  }
  return Result.ok(resolvedBodyToRichPatch(resolved));
};

/**
 * Flatten a ClauseBody to plain text (one line per paragraph) for
 * version diffing. Directive paragraphs are kept: a changed `{% if %}`
 * condition alters fill behaviour and must show up in the diff.
 */
export const clauseBodyToPlainText = (body: ClauseBody): string =>
  body.map((p) => p.text).join("\n");
