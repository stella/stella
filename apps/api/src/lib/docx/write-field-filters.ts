/**
 * Write a field's configuration into the document that declares it.
 *
 * The DOCX is the template, so configuring a field is an edit to the document:
 * the value marker's filter chain is rewritten, in every content part and at
 * every occurrence of the path, and a repeat's own filters are rewritten on
 * the `{% for %}` opener that declares it. Nothing else in the document moves:
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
  isFieldPath,
  qualifyLoopPath,
  qualifyRowScopedPlaceholder,
  renderConditionTag,
  renderForOpener,
  renderValueMarker,
  scanMarkers,
  type FilterCall,
  type RowScope,
  type ScannedMarker,
} from "@stll/template-conditions";

import { templateContentPartPaths, W_NS } from "./ooxml";
import { paragraphSpanText, replaceParagraphTextRanges } from "./rich-patch";

/** The chain to write at one path. A path is either a value marker's or a
 *  `{% for %}` opener's; which one it is, is what the document says. */
export type FieldFilterRewrite = {
  /** The marker to rewrite, loop scoping already applied. */
  path: string;
  filters: readonly FilterCall[];
  /** The manifest path this marker declares, when it is not its own: a
   *  rendering of a registry hit (`company.name`) declares the field the
   *  lookup fills (`company`), so that is the path `written` reports. */
  declares?: string;
};

/** The rule to write into every `{% if %}` / `{% elif %}` tag that names this
 *  path. A rule that decides whether a block shows has no value marker to live
 *  in: the tag it gates is the document's only place for it. */
export type ConditionRewrite = {
  path: string;
  expression: string;
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
type ParagraphRewriteOptions = {
  conditions: ReadonlyMap<string, string>;
  markers: readonly ScannedMarker[];
  rewrites: ReadonlyMap<string, FieldFilterRewrite>;
  scopes: RowScope[];
  written: Set<string>;
};

const rewriteParagraph = ({
  conditions,
  markers,
  rewrites,
  scopes,
  written,
}: ParagraphRewriteOptions): TextRange[] => {
  const ranges: TextRange[] = [];
  /** A marker whose text is already what the rewrite would write is left
   *  alone: a configure call that changes nothing must not republish the
   *  document under a new key. */
  const rewriteTo = (marker: ScannedMarker, value: string): void => {
    if (value !== marker.raw) {
      ranges.push({ start: marker.start, end: marker.end, value });
    }
  };
  for (const marker of markers) {
    const { meta } = marker;
    if (meta.kind === "endfor") {
      scopes.pop();
      continue;
    }
    if (meta.kind === "if" || meta.kind === "elif") {
      // Only a tag that names one path can carry a rule for it: an expression
      // the author already wrote is theirs, not a reference to a named rule.
      const expression = isFieldPath(meta.expr)
        ? conditions.get(qualifyRowScopedPlaceholder(meta.expr, scopes))
        : undefined;
      if (expression !== undefined) {
        written.add(qualifyRowScopedPlaceholder(meta.expr, scopes));
        rewriteTo(
          marker,
          renderConditionTag({
            kind: meta.kind,
            expression,
            prefix: marker.prefix,
          }),
        );
      }
      continue;
    }
    if (meta.kind === "for") {
      const scopedPath = qualifyLoopPath(meta.path, scopes);
      const rewrite = rewrites.get(scopedPath);
      if (rewrite !== undefined) {
        written.add(rewrite.declares ?? scopedPath);
        rewriteTo(
          marker,
          renderForOpener({
            alias: meta.alias,
            path: meta.path,
            filters: rewrite.filters,
            prefix: marker.prefix,
          }),
        );
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
    const rewrite = rewrites.get(scopedPath);
    if (rewrite === undefined) {
      continue;
    }
    written.add(rewrite.declares ?? scopedPath);
    // The marker keeps the spelling the author gave it: rewriting
    // `{{ attorney.name }}` to `{{ attorneys.name }}` would move the field out
    // of its loop.
    rewriteTo(marker, renderValueMarker(meta.expr, rewrite.filters));
  }
  return ranges;
};

const rewritePart = (
  xml: string,
  options: Omit<ParagraphRewriteOptions, "markers">,
): { xml: string; changed: boolean } => {
  const doc = slimdom.parseXmlDocument(xml);
  let changed = false;
  for (const paragraph of doc.getElementsByTagNameNS(W_NS, "p")) {
    const ranges = rewriteParagraph({
      ...options,
      markers: scanMarkers(paragraphSpanText(paragraph)),
    });
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

/**
 * The document with every named path's marker rewritten to carry its chain.
 *
 * Refuses nothing: a path the document does not carry is simply absent from
 * `written`, and a chain the grammar cannot hold must be caught with
 * `unwritableFilterValues` before the call, because a marker written with a
 * brace in it is a marker the scanner stops reading.
 */
export const writeFieldFilters = async (
  docxBuffer: Buffer,
  rewrites: readonly FieldFilterRewrite[],
  conditionRewrites: readonly ConditionRewrite[] = [],
): Promise<WriteFieldFiltersResult> => {
  const written = new Set<string>();
  if (rewrites.length === 0 && conditionRewrites.length === 0) {
    return { buffer: docxBuffer, written };
  }
  const byPath = new Map(
    rewrites.map((rewrite) => [rewrite.path, rewrite] as const),
  );
  const conditions = new Map(
    conditionRewrites.map(({ expression, path }) => [path, expression]),
  );
  const zip = await JSZip.loadAsync(docxBuffer);
  let changed = false;
  // Headers and footers hold markers of their own, and a loop never spans two
  // parts, so each part walks with a stack of its own.
  for (const path of templateContentPartPaths(Object.keys(zip.files))) {
    const entry = zip.file(path);
    if (!entry) {
      continue;
    }
    const rewritten = rewritePart(await entry.async("string"), {
      conditions,
      rewrites: byPath,
      scopes: [],
      written,
    });
    if (rewritten.changed) {
      zip.file(path, rewritten.xml);
      changed = true;
    }
  }
  // A configuration that asks for what the markers already say is not a new
  // document: re-zipping would republish identical content under a new key.
  if (!changed) {
    return { buffer: docxBuffer, written };
  }
  const output = await zip.generateAsync({
    compression: "DEFLATE",
    type: "nodebuffer",
  });
  return { buffer: Buffer.from(output), written };
};
