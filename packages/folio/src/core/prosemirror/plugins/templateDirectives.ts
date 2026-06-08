/**
 * Template-directives scan plugin.
 *
 * Scans the document for legal-template markers and exposes their
 * PM ranges so the paged-canvas overlay can paint rich widgets
 * (field chips, conditional/loop bands) in place of the raw
 * `{{...}}` text. Mirrors the anonymization plugin's shape via the
 * shared {@link createDocScanPlugin} factory; the document text is
 * the only input, so there is no host-pushed config.
 *
 * The grammar itself is NOT defined here: the kinds and the
 * `{{...}}` parser come from `@stll/template-conditions`
 * ({@link scanMarkers}, {@link classifyMarker}), the same module the
 * fill pipeline uses. This file only maps the scanner's text offsets
 * onto ProseMirror positions, so a new directive added to the shared
 * grammar is highlighted here automatically.
 */

import type { Node as PMNode } from "prosemirror-model";
import { PluginKey } from "prosemirror-state";
import type { EditorState } from "prosemirror-state";

import {
  assertNever,
  type DirectiveKind,
  isBlockDirectiveKind,
  type MarkerMeta,
  scanMarkers,
} from "@stll/template-conditions";

import { createDocScanPlugin, getDocScanRanges } from "./createDocScanPlugin";
import type { DocScanState } from "./createDocScanPlugin";
import { collectBlockChunks, joinChunks, offsetToDocPos } from "./pmTextScan";

export type { DirectiveKind };

export type DirectiveRange = {
  /** Inclusive PM doc position of the marker start. */
  from: number;
  /** Exclusive PM doc position of the marker end. */
  to: number;
  kind: DirectiveKind;
  /** Field path, clause name, or condition/loop expression. */
  expr: string;
  /** Clause-slot version selector, e.g. "v3" or "latest". */
  clauseVersion?: string;
  /** True for block directives that occupy their own paragraph. */
  block: boolean;
};

/** The display expression for a marker (field path, clause name, key, condition). */
const directiveExpr = (meta: MarkerMeta): string => {
  switch (meta.kind) {
    case "placeholder":
      return meta.expr;
    case "clause":
      return meta.name;
    case "num":
    case "ref":
      return meta.key;
    case "if":
    case "elseif":
    case "each":
      return meta.expr;
    case "else":
    case "endif":
    case "endeach":
      return "";
    default:
      return assertNever(meta);
  }
};

export const scanDirectives = (doc: PMNode): DirectiveRange[] => {
  const ranges: DirectiveRange[] = [];

  for (const chunks of collectBlockChunks(doc)) {
    const joined = joinChunks(chunks);
    const trimmed = joined.trim();

    // A whole paragraph that is a single block directive gets a block range
    // spanning the line (the overlay pairs opener→closer into a gutter rail).
    const lineMarkers = scanMarkers(trimmed);
    const sole = lineMarkers.length === 1 ? lineMarkers[0] : undefined;
    if (sole && sole.raw === trimmed && isBlockDirectiveKind(sole.meta.kind)) {
      const last = chunks.at(-1);
      ranges.push({
        from: chunks[0]?.start ?? 0,
        to: last ? last.start + last.text.length : 0,
        kind: sole.meta.kind,
        expr: directiveExpr(sole.meta),
        block: true,
      });
      continue;
    }

    // Otherwise, inline markers (fields, clause slots, numbering). Block
    // directives only count when they own the whole paragraph, matching the
    // fill engine, so skip any found mid-line here.
    for (const marker of scanMarkers(joined)) {
      if (isBlockDirectiveKind(marker.meta.kind)) {
        continue;
      }
      const clauseVersion =
        marker.meta.kind === "clause" ? marker.meta.version : undefined;
      ranges.push({
        from: offsetToDocPos(chunks, marker.start),
        to: offsetToDocPos(chunks, marker.end),
        kind: marker.meta.kind,
        expr: directiveExpr(marker.meta),
        block: false,
        ...(clauseVersion !== undefined ? { clauseVersion } : {}),
      });
    }
  }

  return ranges;
};

// Pin the PluginKey to a process-wide symbol so every module
// evaluation (Vite dev double-serve, @stll/folio re-export) resolves
// to the same key instance — otherwise host key-based lookups break.
const KEY_HOLDER_SYMBOL = Symbol.for("stll.folio.templateDirectivesKey");
type KeyHolder = {
  [KEY_HOLDER_SYMBOL]?: PluginKey<DocScanState<undefined, DirectiveRange>>;
};
const keyHolder = globalThis as unknown as KeyHolder;
export const templateDirectivesKey: PluginKey<
  DocScanState<undefined, DirectiveRange>
> =
  keyHolder[KEY_HOLDER_SYMBOL] ??
  (keyHolder[KEY_HOLDER_SYMBOL] = new PluginKey<
    DocScanState<undefined, DirectiveRange>
  >("templateDirectives"));

export type TemplateDirectivesPluginOptions = {
  onRangesChange?: (ranges: readonly DirectiveRange[]) => void;
};

export const createTemplateDirectivesPlugin = ({
  onRangesChange,
}: TemplateDirectivesPluginOptions = {}) =>
  createDocScanPlugin<undefined, DirectiveRange>({
    key: templateDirectivesKey,
    initialConfig: undefined,
    scan: (doc) => scanDirectives(doc),
    ...(onRangesChange ? { onRangesChange } : {}),
  });

export const getTemplateDirectives = (
  state: EditorState,
): readonly DirectiveRange[] => getDocScanRanges(templateDirectivesKey, state);
