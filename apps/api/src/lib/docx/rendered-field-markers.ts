/**
 * Which value markers a fill renders, read from the directive pass itself.
 *
 * Before the pass, every value marker discovery can place is swapped for an
 * inert token naming its entry in a table (its manifest path and its path as
 * authored). The pass then prunes branches and repeats loops exactly as it
 * does for the real fill; a token that survives is a marker the document
 * renders, and the paragraph it survives in carries the values its scope
 * resolves (a loop iteration's bindings, or the document's).
 */

import { panic, Result } from "better-result";
import type * as slimdom from "slimdom";

import { API_VALIDATION_ERROR_CODE } from "@stll/api-contract";

import { HandlerError } from "@/api/lib/errors/tagged-errors";

import type { InlineIterationTextOptions } from "./block-directives";
import { scanPlaceholders } from "./discover-placeholders";
import type { LocatedFieldMarker } from "./discover-template";
import { paragraphOwnText, W_NS } from "./ooxml";
import { paragraphSpanText, replaceParagraphTextRanges } from "./rich-patch";

/** One value marker the pass kept, with the values in scope where it sits. */
export type RenderedFieldOccurrence = {
  /** The manifest path the marker fills. */
  path: string;
  /** The path as authored, resolved against `scope`. */
  expr: string;
  /** A loop iteration's bindings; `undefined` at document scope. */
  scope: Record<string, unknown> | undefined;
};

// The namespace is selected from all authored text before any part is evaluated.
const TOKEN_OPEN = "";
const TOKEN_CLOSE = "";

type FieldMarkerEntry = LocatedFieldMarker & {
  scope?: Record<string, unknown> | undefined;
};

/** Entries and the namespace their swapped tokens use. */
export type FieldMarkerTable = {
  markers: Map<string, FieldMarkerEntry>;
  prefix: string;
  pattern: RegExp;
};

/** Select a deterministic namespace absent from every authored content part. */
export const createFieldMarkerTable = (
  authoredTexts: readonly string[],
): FieldMarkerTable => {
  let delimiter = TOKEN_OPEN;
  while (authoredTexts.some((text) => text.includes(`${delimiter}:`))) {
    delimiter += TOKEN_OPEN;
  }
  const prefix = `${delimiter}:`;
  return {
    markers: new Map(),
    prefix,
    pattern: new RegExp(`${prefix}(?<id>\\d+)${TOKEN_CLOSE}`, "gu"),
  };
};

/** Give each inline copy its own token identity and bindings, so branch pruning
 * and nested expansions operate on the same scope as the real marker. */
export const scopeInlineFieldTokens = (
  table: FieldMarkerTable,
  { text, values, row, alias, arrayPath, loop }: InlineIterationTextOptions,
): string =>
  text.replace(table.pattern, (_token, id: string) => {
    const marker =
      table.markers.get(id) ??
      panic("An inline field token points outside its table");
    const scope = {
      ...values,
      ...marker.scope,
      ...row,
      [alias]: row,
      [arrayPath]: row,
      loop,
    };
    const token = `${table.prefix}${String(table.markers.size)}${TOKEN_CLOSE}`;
    table.markers.set(String(table.markers.size), { ...marker, scope });
    return token;
  });

/**
 * Swap each value marker for its token. Inline expansion gives every repeated
 * copy a separate token identity with that iteration's bindings.
 */
export const swapFieldMarkersForTokens = (
  fieldMarkers: ReadonlyMap<slimdom.Element, readonly LocatedFieldMarker[]>,
  table: FieldMarkerTable,
): Result<void, HandlerError<422>> => {
  for (const [paragraph, markers] of fieldMarkers) {
    const placeholders = scanPlaceholders(paragraphSpanText(paragraph));
    if (placeholders.length !== markers.length) {
      return Result.err(
        new HandlerError({
          status: 422,
          code: API_VALIDATION_ERROR_CODE,
          retryable: false,
          message: "Template field markers differ from paragraph placeholders",
        }),
      );
    }
    const ranges: { start: number; end: number; value: string }[] = [];
    for (const [index, { name, start, end }] of placeholders.entries()) {
      const marker =
        markers[index] ?? panic("A field occurrence has no located marker");
      if (marker.expr !== name) {
        return Result.err(
          new HandlerError({
            status: 422,
            code: API_VALIDATION_ERROR_CODE,
            retryable: false,
            message:
              "Template field marker expression differs from its placeholder",
          }),
        );
      }
      const id = String(table.markers.size);
      table.markers.set(id, marker);
      ranges.push({ start, end, value: `${table.prefix}${id}${TOKEN_CLOSE}` });
    }
    replaceParagraphTextRanges(paragraph, ranges);
  }
  return Result.ok(undefined);
};

/** Every token the pass kept in `container`, with its paragraph's scope. */
export const collectRenderedFieldTokens = (
  container: slimdom.Element,
  loopScopes: ReadonlyMap<slimdom.Element, Record<string, unknown>>,
  table: FieldMarkerTable,
  into: RenderedFieldOccurrence[],
): void => {
  for (const paragraph of container.getElementsByTagNameNS(W_NS, "p")) {
    const text = paragraphOwnText(paragraph);
    if (!text.includes(table.prefix)) {
      continue;
    }
    const scope = loopScopes.get(paragraph);
    for (const match of text.matchAll(table.pattern)) {
      const marker =
        table.markers.get(match.groups?.["id"] ?? "") ??
        panic("A rendered field token points outside its table");
      into.push({
        path: marker.path,
        expr: marker.expr,
        scope: marker.scope ?? scope,
      });
    }
  }
};
