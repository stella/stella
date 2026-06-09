import {
  computePageNumber,
  formatDate,
  parseFieldInstruction,
} from "../docx/fieldParser";
import type { ParsedFieldInstruction } from "../docx/fieldParser";
import type { FieldContext } from "./fieldContext";

/** The `\@` date picture, or undefined. Unlike the general format switch, this
 *  must NOT match `\*` (e.g. `\* MERGEFORMAT`), which is not a date format. */
function dateFormatSwitch(parsed: ParsedFieldInstruction): string | undefined {
  return parsed.switches.find((s) => s.switch === "@")?.value;
}

function hasRefNumberingSwitch(parsed: ParsedFieldInstruction): boolean {
  return hasAnySwitch(parsed, ["n", "r", "w"]);
}

function hasPageRefPositionSwitch(parsed: ParsedFieldInstruction): boolean {
  return hasAnySwitch(parsed, ["p"]);
}

function hasSeqHiddenSwitch(parsed: ParsedFieldInstruction): boolean {
  return hasAnySwitch(parsed, ["h"]);
}

function hasAnySwitch(
  parsed: ParsedFieldInstruction,
  names: readonly string[],
): boolean {
  return names.some((name) => hasSwitch(parsed, name));
}

function hasSwitch(parsed: ParsedFieldInstruction, name: string): boolean {
  const normalized = name.toLowerCase();
  if (parsed.switches.some((s) => s.switch.toLowerCase() === normalized)) {
    return true;
  }
  const pattern = new RegExp(`\\\\${normalized}\\b`, "iu");
  return pattern.test(parsed.raw);
}

type EvaluateFieldOptions = {
  /** Shown for unsupported field types and unresolved references. */
  fallback?: string;
  /** Run identity (`pmStart`) used to look up a precomputed SEQ value. */
  instanceId?: number;
  /** Locked fields preserve their cached result instead of recalculating. */
  locked?: boolean;
};

/**
 * Evaluate a parsed field instruction to its display string for `ctx`.
 *
 * Returns `options.fallback` (default empty) for field types this engine does
 * not compute and for references that do not resolve in the current layout, so
 * an unsupported or dangling field keeps its last-known cached text rather than
 * vanishing. Pure: all position-dependent inputs come from `ctx`.
 */
export function evaluateField(
  parsed: ParsedFieldInstruction,
  ctx: FieldContext,
  options: EvaluateFieldOptions = {},
): string {
  const fallback = options.fallback ?? "";
  if (options.locked) {
    return fallback;
  }

  switch (parsed.type) {
    case "PAGE":
      return computePageNumber(ctx.pageNumber, parsed);
    case "NUMPAGES":
      return computePageNumber(ctx.totalPages, parsed);
    case "SECTIONPAGES":
      return ctx.sectionPages === undefined
        ? fallback
        : computePageNumber(ctx.sectionPages, parsed);

    case "TIME": {
      const format = dateFormatSwitch(parsed);
      return format
        ? formatDate(ctx.now, format)
        : ctx.now.toLocaleTimeString();
    }

    case "DATE": {
      const format = dateFormatSwitch(parsed);
      return format
        ? formatDate(ctx.now, format)
        : ctx.now.toLocaleDateString();
    }

    case "CREATEDATE":
    case "SAVEDATE":
    case "PRINTDATE":
      return fallback;

    case "PAGEREF": {
      if (hasPageRefPositionSwitch(parsed)) {
        return fallback;
      }
      const page = parsed.argument
        ? ctx.bookmarkPages.get(parsed.argument)
        : undefined;
      return page === undefined ? fallback : computePageNumber(page, parsed);
    }

    case "REF": {
      if (hasRefNumberingSwitch(parsed)) {
        return fallback;
      }
      const text = parsed.argument
        ? ctx.bookmarkText.get(parsed.argument)
        : undefined;
      return text ?? fallback;
    }

    case "SEQ": {
      if (hasSeqHiddenSwitch(parsed)) {
        return fallback;
      }
      const value =
        options.instanceId === undefined
          ? undefined
          : ctx.seqValues.get(options.instanceId);
      return value === undefined ? fallback : computePageNumber(value, parsed);
    }

    default:
      return fallback;
  }
}

/** Parse `instruction` then evaluate it; convenience for callers holding the
 *  raw instruction string rather than a pre-parsed instruction. */
export function evaluateFieldInstruction(
  instruction: string,
  ctx: FieldContext,
  options: EvaluateFieldOptions = {},
): string {
  return evaluateField(parseFieldInstruction(instruction), ctx, options);
}
