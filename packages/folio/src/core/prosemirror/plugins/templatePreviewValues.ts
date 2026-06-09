/**
 * Template Preview Values Plugin
 *
 * Live fill preview for template documents: given a map of field path →
 * typed value, every matching `{{path}}` marker is visually replaced by
 * the value — the marker text is hidden by an inline decoration and the
 * value is injected as a widget in its place. The document itself is
 * never modified; clearing the preview restores the markers.
 *
 * Two render modes: `highlighted` paints the substituted values with the
 * preview accent so it is unmistakably a preview; `plain` renders them
 * as ordinary text, approximating the final filled document.
 *
 * Updates are pushed via {@link setTemplatePreviewValues}; the host wires
 * this to its fill inputs.
 */

import type { Node as PMNode } from "prosemirror-model";
import { Plugin, PluginKey } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { Decoration, DecorationSet } from "prosemirror-view";

import { scanDirectives } from "./templateDirectives";

export type TemplatePreviewValues = {
  /** Field path → value to display in place of `{{path}}` markers. */
  values: Record<string, string>;
  /** `highlighted` marks substitutions with the preview accent. */
  mode: "highlighted" | "plain";
};

/**
 * One `{{path}}` marker matched by an active preview value. Exposed on
 * the plugin state so the paged editor (whose visible pages never see
 * PM decorations) can project the same substitutions onto its overlay.
 */
export type TemplatePreviewEntry = {
  /** Inclusive PM doc position of the marker start. */
  from: number;
  /** Exclusive PM doc position of the marker end. */
  to: number;
  /** Field path the marker resolves to. */
  expr: string;
  /** The typed value displayed in place of the marker. */
  value: string;
};

type TemplatePreviewState = {
  preview: TemplatePreviewValues | null;
  entries: TemplatePreviewEntry[];
  decorationSet: DecorationSet;
};

export const templatePreviewValuesKey = new PluginKey<TemplatePreviewState>(
  "templatePreviewValues",
);

function buildValueWidget(
  value: string,
  mode: TemplatePreviewValues["mode"],
): () => HTMLElement {
  return () => {
    const span = document.createElement("span");
    span.className =
      mode === "highlighted"
        ? "folio-template-preview-value folio-template-preview-value--highlighted"
        : "folio-template-preview-value";
    span.contentEditable = "false";
    span.textContent = value;
    return span;
  };
}

function collectPreviewEntries(
  doc: PMNode,
  preview: TemplatePreviewValues | null,
): TemplatePreviewEntry[] {
  if (!preview || Object.keys(preview.values).length === 0) {
    return [];
  }

  const entries: TemplatePreviewEntry[] = [];
  for (const range of scanDirectives(doc)) {
    if (range.kind !== "placeholder") {
      continue;
    }
    const value = preview.values[range.expr];
    if (value === undefined || value === "") {
      continue;
    }
    entries.push({ from: range.from, to: range.to, expr: range.expr, value });
  }
  return entries;
}

function buildDecorationSet(
  doc: PMNode,
  entries: TemplatePreviewEntry[],
  mode: TemplatePreviewValues["mode"],
): DecorationSet {
  if (entries.length === 0) {
    return DecorationSet.empty;
  }

  const decorations: Decoration[] = [];
  for (const entry of entries) {
    decorations.push(
      Decoration.inline(
        entry.from,
        entry.to,
        { class: "folio-template-preview-original" },
        { inclusiveStart: false, inclusiveEnd: false },
      ),
      Decoration.widget(entry.from, buildValueWidget(entry.value, mode), {
        side: 1,
        marks: [],
        ignoreSelection: true,
        key: `folio-template-preview-${entry.expr}-${entry.from}-${mode}-${entry.value}`,
      }),
    );
  }
  return DecorationSet.create(doc, decorations);
}

export function createTemplatePreviewValuesPlugin(): Plugin<TemplatePreviewState> {
  return new Plugin<TemplatePreviewState>({
    key: templatePreviewValuesKey,
    state: {
      init(): TemplatePreviewState {
        return {
          preview: null,
          entries: [],
          decorationSet: DecorationSet.empty,
        };
      },
      apply(tr, prev, _oldState, newState): TemplatePreviewState {
        const meta = tr.getMeta(templatePreviewValuesKey) as
          | { preview: TemplatePreviewValues | null }
          | undefined;
        if (meta !== undefined) {
          const entries = collectPreviewEntries(newState.doc, meta.preview);
          return {
            preview: meta.preview,
            entries,
            decorationSet: buildDecorationSet(
              newState.doc,
              entries,
              meta.preview?.mode ?? "plain",
            ),
          };
        }
        if (tr.docChanged && prev.preview) {
          const entries = collectPreviewEntries(newState.doc, prev.preview);
          return {
            preview: prev.preview,
            entries,
            decorationSet: buildDecorationSet(
              newState.doc,
              entries,
              prev.preview.mode,
            ),
          };
        }
        return prev;
      },
    },
    props: {
      decorations(state) {
        return templatePreviewValuesKey.getState(state)?.decorationSet;
      },
    },
  });
}

/** Push (or clear, with `null`) the live fill preview into the editor. */
export const setTemplatePreviewValues = (
  view: EditorView,
  preview: TemplatePreviewValues | null,
): void => {
  view.dispatch(view.state.tr.setMeta(templatePreviewValuesKey, { preview }));
};
