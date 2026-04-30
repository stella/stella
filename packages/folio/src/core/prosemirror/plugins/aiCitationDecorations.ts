/**
 * AI Citation Decorations Plugin
 *
 * Renders pointer-back-to-source highlights on Folio (DOCX) ranges
 * cited by an AI answer. Distinct from the suggestion-decoration
 * plugin: citations are read-only pointers (no edit semantics) and
 * usually appear briefly when the user clicks a citation chip in the
 * thread.
 *
 * The host pushes updates via the `setAICitationsMeta` /
 * `setActiveCitationMeta` helpers below.
 */

import type { Node as PMNode } from "prosemirror-model";
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";

export const aiCitationDecorationsKey =
  new PluginKey<AICitationDecorationState>("aiCitationDecorations");

const SET_META = "set";
const ACTIVE_META = "active";

export type AICitationRange = {
  /** Stable id from the thread message. */
  id: string;
  from: number;
  to: number;
};

type AICitationDecorationState = {
  citations: AICitationRange[];
  activeId: string | null;
  decorationSet: DecorationSet;
};

function buildDecorationSet(
  doc: PMNode,
  citations: AICitationRange[],
  activeId: string | null,
): DecorationSet {
  if (citations.length === 0) {
    return DecorationSet.empty;
  }
  const docSize = doc.content.size;
  const decorations: Decoration[] = [];
  for (const c of citations) {
    const from = Math.max(0, Math.min(c.from, docSize));
    const to = Math.max(from, Math.min(c.to, docSize));
    if (to === from) {
      continue;
    }
    const isActive = activeId === c.id;
    decorations.push(
      Decoration.inline(
        from,
        to,
        {
          class: [
            "folio-ai-citation",
            isActive ? "folio-ai-citation--active" : "",
          ]
            .filter(Boolean)
            .join(" "),
          "data-folio-ai-citation-id": c.id,
        },
        { inclusiveStart: false, inclusiveEnd: false },
      ),
    );
  }
  return DecorationSet.create(doc, decorations);
}

/**
 * ProseMirror plugin that renders AI citations as inline highlights.
 * Use {@link setAICitationsMeta} / {@link setActiveCitationMeta} to
 * update which ranges are shown and which one is currently active
 * (e.g., the one the user just clicked).
 */
export function createAICitationDecorationsPlugin(): Plugin<AICitationDecorationState> {
  return new Plugin<AICitationDecorationState>({
    key: aiCitationDecorationsKey,
    state: {
      init(_, state): AICitationDecorationState {
        return {
          citations: [],
          activeId: null,
          decorationSet: buildDecorationSet(state.doc, [], null),
        };
      },
      apply(tr, prev, _oldState, newState): AICitationDecorationState {
        const meta = tr.getMeta(aiCitationDecorationsKey) as
          | { type: typeof SET_META; citations: AICitationRange[] }
          | { type: typeof ACTIVE_META; activeId: string | null }
          | undefined;

        if (meta?.type === SET_META) {
          return {
            citations: meta.citations,
            activeId: prev.activeId,
            decorationSet: buildDecorationSet(
              newState.doc,
              meta.citations,
              prev.activeId,
            ),
          };
        }

        if (meta?.type === ACTIVE_META) {
          return {
            citations: prev.citations,
            activeId: meta.activeId,
            decorationSet: buildDecorationSet(
              newState.doc,
              prev.citations,
              meta.activeId,
            ),
          };
        }

        if (tr.docChanged) {
          // oxlint-disable-next-line unicorn/no-array-method-this-argument -- DecorationSet.map is not Array#map
          const mapped = prev.decorationSet.map(tr.mapping, tr.doc);
          return {
            citations: prev.citations,
            activeId: prev.activeId,
            decorationSet: mapped,
          };
        }
        return prev;
      },
    },
    props: {
      decorations(state) {
        return aiCitationDecorationsKey.getState(state)?.decorationSet ?? null;
      },
    },
  });
}

export function setAICitationsMeta(citations: AICitationRange[]): {
  key: PluginKey<AICitationDecorationState>;
  payload: { type: typeof SET_META; citations: AICitationRange[] };
} {
  return {
    key: aiCitationDecorationsKey,
    payload: { type: SET_META, citations },
  };
}

export function setActiveCitationMeta(activeId: string | null): {
  key: PluginKey<AICitationDecorationState>;
  payload: { type: typeof ACTIVE_META; activeId: string | null };
} {
  return {
    key: aiCitationDecorationsKey,
    payload: { type: ACTIVE_META, activeId },
  };
}
