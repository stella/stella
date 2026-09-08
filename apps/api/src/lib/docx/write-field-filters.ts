/**
 * Write a field's configuration into the document that declares it.
 *
 * The DOCX is the template, so configuring a field is an edit to the document:
 * the value marker's filter chain is rewritten, in every content part and at
 * every occurrence of the path, and a repeat's own filters are rewritten on
 * the `{% for %}` opener that declares it. Nothing else in the document moves —
 * the rewrite goes through the same run-splitting machinery the fill patcher
 * uses, so the author's formatting survives it.
 *
 * The path a rewrite names is the one the manifest speaks: a marker written as
 * `{{ attorney.name }}` inside `{% for attorney in attorneys %}` is the marker
 * for `attorneys.name`, resolved through the same loop scoping discovery
 * applies.
 */

import JSZip from "jszip";
import * as slimdom from "slimdom";

import {
  renderForOpener,
  renderValueMarker,
  scanMarkers,
  unwritableFilterValues,
  type FilterCall,
  type ScannedMarker,
} from "@stll/template-conditions";

import { qualifyLoopPath, qualifyRowScopedPlaceholder } from "./loop-scope";
import type { RowScope } from "./loop-scope";
import { templateContentPartPaths, W_NS } from "./ooxml";
import { paragraphSpanText, replaceParagraphTextRanges } from "./rich-patch";

/** The chain to write at one path. A path is either a value marker's or a
 *  `{% for %}` opener's; which one it is, is what the document says. */
export type FieldFilterRewrite = {
  /** The manifest path, loop scoping already applied. */
  path: string;
  filters: readonly FilterCall[];
};

/** A value the grammar cannot hold, named against the path that asked for it,
 *  so a caller can report the property instead of writing text the scanner
 *  would read back as something else. */
export type UnwritableRewrite = {
  path: string;
  filter: string;
  value: string;
};

export type WriteFieldFiltersResult = {
  buffer: Buffer;
  /** The paths a marker was actually rewritten for. A path the document does
   *  not carry is absent, which is how the caller learns to refuse the entry
   *  rather than reporting a change that never happened. */
  written: Set<string>;
};

/** One paragraph's pending edits, in the coordinate space of its span text. */
type TextRange = { start: number; end: number; value: string };

/**
 * Walk the markers of one paragraph in document order, keeping the loop stack
 * the enclosing document has built so far, and collect the rewrites that land
 * in this paragraph.
 *
 * The stack is shared across paragraphs because a `{% for %}` on its own
 * paragraph opens a scope the following paragraphs sit in; an inline loop
 * opens and closes within one. Both forms are the same tags in the same
 * document order, so one walk covers them.
 */
const rewriteParagraph = (
  markers: readonly ScannedMarker[],
  scopes: RowScope[],
  rewrites: ReadonlyMap<string, readonly FilterCall[]>,
  written: Set<string>,
): TextRange[] => {
  const ranges: TextRange[] = [];
  for (const marker of markers) {
    const { meta } = marker;
    if (meta.kind === "endfor") {
      scopes.pop();
      continue;
    }
    if (meta.kind === "for") {
      const scopedPath = qualifyLoopPath(meta.path, scopes);
      const filters = rewrites.get(scopedPath);
      if (filters !== undefined) {
        written.add(scopedPath);
        ranges.push({
          start: marker.start,
          end: marker.end,
          value: renderForOpener({
            alias: meta.alias,
            path: meta.path,
            filters,
            prefix: marker.prefix,
          }),
        });
      }
      scopes.push({
        alias: meta.alias,
        declaredPath: meta.path,
        scopedPath,
      });
      continue;
    }
    if (meta.kind !== "placeholder") {
      continue;
    }
    const scopedPath = qualifyRowScopedPlaceholder(meta.expr, scopes);
    const filters = rewrites.get(scopedPath);
    if (filters === undefined) {
      continue;
    }
    written.add(scopedPath);
    ranges.push({
      start: marker.start,
      end: marker.end,
      // The marker keeps the spelling the author gave it: rewriting
      // `{{ attorney.name }}` to `{{ attorneys.name }}` would move the field
      // out of its loop.
      value: renderValueMarker(meta.expr, filters),
    });
  }
  return ranges;
};

const rewritePart = (
  xml: string,
  rewrites: ReadonlyMap<string, readonly FilterCall[]>,
  scopes: RowScope[],
  written: Set<string>,
): { xml: string; changed: boolean } => {
  const doc = slimdom.parseXmlDocument(xml);
  let changed = false;
  for (const paragraph of doc.getElementsByTagNameNS(W_NS, "p")) {
    const ranges = rewriteParagraph(
      scanMarkers(paragraphSpanText(paragraph)),
      scopes,
      rewrites,
      written,
    );
    if (ranges.length === 0) {
      continue;
    }
    replaceParagraphTextRanges(paragraph, ranges);
    changed = true;
  }
  return {
    xml: changed ? slimdom.serializeToWellFormedString(doc) : xml,
    changed,
  };
};

/** Every rewrite whose chain carries a value no marker can hold. */
export const unwritableRewrites = (
  rewrites: readonly FieldFilterRewrite[],
): UnwritableRewrite[] =>
  rewrites.flatMap(({ filters, path }) =>
    unwritableFilterValues(filters).map(({ filter, value }) => ({
      path,
      filter,
      value: String(value),
    })),
  );

/**
 * The document with every named path's marker rewritten to carry its chain.
 *
 * Refuses nothing: a path the document does not carry is simply absent from
 * `written`, and a chain the grammar cannot hold must be caught with
 * {@link unwritableRewrites} before the call, because a marker written with a
 * brace in it is a marker the scanner stops reading.
 */
export const writeFieldFilters = async (
  docxBuffer: Buffer,
  rewrites: readonly FieldFilterRewrite[],
): Promise<WriteFieldFiltersResult> => {
  const written = new Set<string>();
  if (rewrites.length === 0) {
    return { buffer: docxBuffer, written };
  }
  const byPath = new Map(rewrites.map(({ filters, path }) => [path, filters]));
  const zip = await JSZip.loadAsync(docxBuffer);
  // Headers and footers hold markers of their own, and a loop never spans two
  // parts, so each part walks with a stack of its own.
  for (const path of templateContentPartPaths(Object.keys(zip.files))) {
    const entry = zip.file(path);
    if (!entry) {
      continue;
    }
    const rewritten = rewritePart(
      await entry.async("string"),
      byPath,
      [],
      written,
    );
    if (rewritten.changed) {
      zip.file(path, rewritten.xml);
    }
  }
  const output = await zip.generateAsync({
    compression: "DEFLATE",
    type: "nodebuffer",
  });
  return { buffer: Buffer.from(output), written };
};
