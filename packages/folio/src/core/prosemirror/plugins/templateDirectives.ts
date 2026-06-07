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
 * Grammar matches the server-side handlers (discover-placeholders,
 * block-directives, discover-clause-slots) so the editor highlights
 * exactly what the fill pipeline will act on:
 *  - `{{placeholder}}` / `{{dotted.path}}` — inline fields
 *  - `{{@clause:Name}}` / `{{@clause:Name:v3}}` — inline clause slots
 *  - `{{#if expr}}` `{{#elseif expr}}` `{{#else}}` `{{/if}}`
 *    `{{#each expr}}` `{{/each}}` — block directives (own paragraph)
 */

import type { Node as PMNode } from "prosemirror-model";
import { PluginKey } from "prosemirror-state";
import type { EditorState } from "prosemirror-state";

import { createDocScanPlugin, getDocScanRanges } from "./createDocScanPlugin";
import type { DocScanState } from "./createDocScanPlugin";
import { collectBlockChunks, joinChunks, offsetToDocPos } from "./pmTextScan";

export type DirectiveKind =
  | "placeholder"
  | "clause"
  | "if"
  | "elseif"
  | "else"
  | "endif"
  | "each"
  | "endeach";

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

// Inline field: {{name}}, {{ company.name }}, also matches {{@clause:..}}
// (filtered out below in favour of the clause-specific scan). The `\s*` inside
// the braces tolerates surrounding whitespace without polluting the capture.
const PLACEHOLDER_RE = /\{\{\s*([\p{L}\p{N}_.@:-]+)\s*\}\}/gu;
// Block directive occupying its own paragraph (anchored ^...$).
const BLOCK_DIRECTIVE_RE =
  /^\s*\{\{\s*(#if|#elseif|#else|#each|\/if|\/each)\s*(.*?)\}\}\s*$/u;
// Inline clause slot: {{@clause:Name}}, {{ @clause:Name:v3 }}.
const CLAUSE_SLOT_RE = /\{\{\s*@clause:([^:}\s]+)(?::([^}\s]+))?\s*\}\}/gu;

const BLOCK_KIND: Record<string, DirectiveKind> = {
  "#if": "if",
  "#elseif": "elseif",
  "#else": "else",
  "/if": "endif",
  "#each": "each",
  "/each": "endeach",
};

export const scanDirectives = (doc: PMNode): DirectiveRange[] => {
  const ranges: DirectiveRange[] = [];

  for (const chunks of collectBlockChunks(doc)) {
    const joined = joinChunks(chunks);

    // A whole paragraph that is a single block directive.
    const blockMatch = BLOCK_DIRECTIVE_RE.exec(joined);
    const blockKind = blockMatch ? BLOCK_KIND[blockMatch[1] ?? ""] : undefined;
    if (blockMatch && blockKind) {
      const last = chunks.at(-1);
      ranges.push({
        from: chunks[0]?.start ?? 0,
        to: last ? last.start + last.text.length : 0,
        kind: blockKind,
        expr: (blockMatch[2] ?? "").trim(),
        block: true,
      });
      continue;
    }

    // Inline clause slots first so the generic placeholder regex
    // does not double-claim the same `{{@clause:...}}` span.
    CLAUSE_SLOT_RE.lastIndex = 0;
    let clauseMatch = CLAUSE_SLOT_RE.exec(joined);
    while (clauseMatch !== null) {
      ranges.push({
        from: offsetToDocPos(chunks, clauseMatch.index),
        to: offsetToDocPos(chunks, clauseMatch.index + clauseMatch[0].length),
        kind: "clause",
        expr: clauseMatch[1] ?? "",
        block: false,
        ...(clauseMatch[2] !== undefined
          ? { clauseVersion: clauseMatch[2] }
          : {}),
      });
      clauseMatch = CLAUSE_SLOT_RE.exec(joined);
    }

    PLACEHOLDER_RE.lastIndex = 0;
    let fieldMatch = PLACEHOLDER_RE.exec(joined);
    while (fieldMatch !== null) {
      const inner = fieldMatch[1] ?? "";
      // Skip clause slots (handled above) — only plain fields here.
      if (!inner.startsWith("@")) {
        ranges.push({
          from: offsetToDocPos(chunks, fieldMatch.index),
          to: offsetToDocPos(chunks, fieldMatch.index + fieldMatch[0].length),
          kind: "placeholder",
          expr: inner,
          block: false,
        });
      }
      fieldMatch = PLACEHOLDER_RE.exec(joined);
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
