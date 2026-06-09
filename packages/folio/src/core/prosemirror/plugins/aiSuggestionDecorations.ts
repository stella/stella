/**
 * AI Suggestion Decorations Plugin
 *
 * Renders pending AI suggestions as non-mutating ProseMirror decorations
 * — subtle dotted underlines on the suggested ranges. The focused
 * suggestion additionally previews its change in the text: the original
 * range is struck through and the suggested text is injected after it
 * as a widget. The document itself is never modified by the suggestion
 * queue; decorations live purely in the view layer.
 *
 * The plugin keeps a `DecorationSet` derived from the suggestion list.
 * Updates are pushed via the `setAISuggestions` meta key, which the
 * Folio editor wires up whenever the suggestion list changes.
 */

import type { Node as PMNode } from "prosemirror-model";
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";

import type {
  AISuggestion,
  AISuggestionSeverity,
} from "../../ai-suggestions/types";

export const aiSuggestionDecorationsKey =
  new PluginKey<AISuggestionDecorationState>("aiSuggestionDecorations");

const SET_META = "set";
const FOCUS_META = "focus";

type AISuggestionDecorationState = {
  suggestions: AISuggestion[];
  focusedId: string | null;
  decorationSet: DecorationSet;
};

const SEVERITY_CLASS: Record<AISuggestionSeverity, string> = {
  typo: "folio-ai-suggestion--typo",
  style: "folio-ai-suggestion--style",
  substantive: "folio-ai-suggestion--substantive",
};

/**
 * Lazy DOM factory for the focused suggestion's in-text replacement
 * preview. Returned as a closure so the element is only created when
 * the view draws the widget (keeps the build side-effect free for
 * headless state updates).
 */
function buildReplacementWidget(suggestion: AISuggestion): () => HTMLElement {
  return () => {
    const span = document.createElement("span");
    span.className = "folio-ai-suggestion--focused-replacement";
    span.dataset["folioAiSuggestionId"] = suggestion.id;
    span.contentEditable = "false";
    span.textContent = suggestion.suggestedText;
    return span;
  };
}

function buildDecorationSet(
  doc: PMNode,
  suggestions: AISuggestion[],
  focusedId: string | null,
): DecorationSet {
  if (suggestions.length === 0) {
    return DecorationSet.empty;
  }

  const docSize = doc.content.size;
  const decorations: Decoration[] = [];

  for (const suggestion of suggestions) {
    if (suggestion.status !== "pending") {
      continue;
    }
    const from = Math.max(0, Math.min(suggestion.range.from, docSize));
    const to = Math.max(from, Math.min(suggestion.range.to, docSize));
    if (to === from) {
      continue;
    }
    const isFocused = focusedId === suggestion.id;
    decorations.push(
      Decoration.inline(
        from,
        to,
        {
          class: [
            "folio-ai-suggestion",
            SEVERITY_CLASS[suggestion.severity],
            isFocused ? "folio-ai-suggestion--focused" : "",
            isFocused ? "folio-ai-suggestion--focused-original" : "",
          ]
            .filter(Boolean)
            .join(" "),
          "data-folio-ai-suggestion-id": suggestion.id,
        },
        { inclusiveStart: false, inclusiveEnd: false },
      ),
    );
    // The focused suggestion previews its change in the document
    // itself: the original range reads as deleted (see the
    // `--focused-original` class above) and the proposed text is
    // injected right after it as a widget. A pure deletion (empty
    // suggestedText) has nothing to inject — the strikethrough alone
    // carries the preview.
    if (isFocused && suggestion.suggestedText.length > 0) {
      decorations.push(
        Decoration.widget(to, buildReplacementWidget(suggestion), {
          side: 1,
          marks: [],
          ignoreSelection: true,
          key: `folio-ai-suggestion-replacement-${suggestion.id}`,
        }),
      );
    }
  }

  return DecorationSet.create(doc, decorations);
}

/**
 * ProseMirror plugin that renders AI suggestions as inline decorations.
 *
 * Use {@link setAISuggestionsMeta} to update the list, and
 * {@link setFocusedSuggestionMeta} to highlight the active one when the
 * user navigates the review panel.
 */
export function createAISuggestionDecorationsPlugin(): Plugin<AISuggestionDecorationState> {
  return new Plugin<AISuggestionDecorationState>({
    key: aiSuggestionDecorationsKey,
    state: {
      init(_, state): AISuggestionDecorationState {
        return {
          suggestions: [],
          focusedId: null,
          decorationSet: buildDecorationSet(state.doc, [], null),
        };
      },
      apply(tr, prev, _oldState, newState): AISuggestionDecorationState {
        const setMeta = tr.getMeta(aiSuggestionDecorationsKey) as
          | { type: typeof SET_META; suggestions: AISuggestion[] }
          | { type: typeof FOCUS_META; focusedId: string | null }
          | undefined;

        if (setMeta?.type === SET_META) {
          return {
            suggestions: setMeta.suggestions,
            focusedId: prev.focusedId,
            decorationSet: buildDecorationSet(
              newState.doc,
              setMeta.suggestions,
              prev.focusedId,
            ),
          };
        }

        if (setMeta?.type === FOCUS_META) {
          return {
            suggestions: prev.suggestions,
            focusedId: setMeta.focusedId,
            decorationSet: buildDecorationSet(
              newState.doc,
              prev.suggestions,
              setMeta.focusedId,
            ),
          };
        }

        if (tr.docChanged) {
          // oxlint-disable-next-line unicorn/no-array-method-this-argument -- DecorationSet.map is not Array#map
          const mapped = prev.decorationSet.map(tr.mapping, tr.doc);
          return {
            suggestions: prev.suggestions,
            focusedId: prev.focusedId,
            decorationSet: mapped,
          };
        }
        return prev;
      },
    },
    props: {
      decorations(state) {
        return (
          aiSuggestionDecorationsKey.getState(state)?.decorationSet ?? null
        );
      },
    },
  });
}

export function setAISuggestionsMeta(suggestions: AISuggestion[]): {
  key: PluginKey<AISuggestionDecorationState>;
  payload: { type: typeof SET_META; suggestions: AISuggestion[] };
} {
  return {
    key: aiSuggestionDecorationsKey,
    payload: { type: SET_META, suggestions },
  };
}

export function setFocusedSuggestionMeta(focusedId: string | null): {
  key: PluginKey<AISuggestionDecorationState>;
  payload: { type: typeof FOCUS_META; focusedId: string | null };
} {
  return {
    key: aiSuggestionDecorationsKey,
    payload: { type: FOCUS_META, focusedId },
  };
}
