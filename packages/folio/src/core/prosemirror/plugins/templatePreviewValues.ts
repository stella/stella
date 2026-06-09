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

type TemplatePreviewState = {
  preview: TemplatePreviewValues | null;
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

function buildDecorationSet(
  doc: PMNode,
  preview: TemplatePreviewValues | null,
): DecorationSet {
  if (!preview || Object.keys(preview.values).length === 0) {
    return DecorationSet.empty;
  }

  const decorations: Decoration[] = [];
  for (const range of scanDirectives(doc)) {
    if (range.kind !== "placeholder") {
      continue;
    }
    const value = preview.values[range.expr];
    if (value === undefined || value === "") {
      continue;
    }
    decorations.push(
      Decoration.inline(
        range.from,
        range.to,
        { class: "folio-template-preview-original" },
        { inclusiveStart: false, inclusiveEnd: false },
      ),
      Decoration.widget(range.from, buildValueWidget(value, preview.mode), {
        side: 1,
        marks: [],
        ignoreSelection: true,
        key: `folio-template-preview-${range.expr}-${range.from}-${preview.mode}-${value}`,
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
        return { preview: null, decorationSet: DecorationSet.empty };
      },
      apply(tr, prev, _oldState, newState): TemplatePreviewState {
        const meta = tr.getMeta(templatePreviewValuesKey) as
          | { preview: TemplatePreviewValues | null }
          | undefined;
        if (meta !== undefined) {
          return {
            preview: meta.preview,
            decorationSet: buildDecorationSet(newState.doc, meta.preview),
          };
        }
        if (tr.docChanged && prev.preview) {
          return {
            preview: prev.preview,
            decorationSet: buildDecorationSet(newState.doc, prev.preview),
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
