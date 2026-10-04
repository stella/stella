import { panic, Result } from "better-result";

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
import { discoverTemplate } from "@/api/lib/docx/discover-template";
import { processInlineConditions } from "@/api/lib/docx/inline-conditions";
import { paragraphText, W_NS } from "@/api/lib/docx/ooxml";
import {
  paragraphSpanText,
  patchParagraphPlaceholders,
  replaceParagraphTextRanges,
} from "@/api/lib/docx/rich-patch";
import type {
  ClauseProvenance,
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
  enclosingLoop?: Record<LoopProperty, number | boolean> | undefined;
  slotKey: string;
  namedConditions?: NamedCondition[] | undefined;
  source?: "stored" | "authored" | undefined;
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
  if (
    !body.some((paragraph) => {
      const text = paragraph.isDirective
        ? paragraph.text
        : paragraphRuns(paragraph)
            .map(({ text: runText }) => runText)
            .join("");
      return text.includes("{{") || text.includes("{%");
    })
  ) {
    return Result.ok(resolvedBodyToRichPatch(body));
  }

  const container = clauseDirectiveContainer(body);

  const conditionValues = readConditionRawValues(values);
  const processingContext = createDirectiveProcessingContext();
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
  if (errors.length > 0 || inlineErrors.length > 0) {
    return structureError([...errors, ...inlineErrors]);
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
