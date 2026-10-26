import { useState, useSyncExternalStore } from "react";

import { panic } from "better-result";
import { createStore } from "zustand";

import {
  applyMarqueeSelection,
  getDraggedItems,
  rectsIntersect,
} from "@/components/workspaces/kanban/kanban-selection.logic";
import type {
  KanbanCardDragItem,
  MarqueeMode,
  ViewportRect,
} from "@/components/workspaces/kanban/kanban-selection.logic";
import {
  applySelectionGesture,
  SELECTION_GESTURE,
} from "@/lib/multi-selection.logic";
import type {
  MultiSelection,
  SelectionGesture,
} from "@/lib/multi-selection.logic";

/**
 * The selected cards, each with the drag item it last rendered as, so a drag
 * can carry a selected card that has since scrolled out of its virtualized
 * column. The map's keys are the selection; there is no second id list to
 * fall out of step with it.
 */
type KanbanSelectionState = {
  items: ReadonlyMap<string, KanbanCardDragItem>;
  anchorId: string | null;
};

const EMPTY_STATE: KanbanSelectionState = { items: new Map(), anchorId: null };

const toMultiSelection = ({
  items,
  anchorId,
}: KanbanSelectionState): MultiSelection => ({
  selectedIds: new Set(items.keys()),
  anchorId,
});

type SelectCardOptions = {
  gesture: SelectionGesture;
  item: KanbanCardDragItem;
  /**
   * The cards a Shift-click range may span, in display order: the card's own
   * column or subgroup cell. Read only for a range.
   */
  getScope: () => readonly KanbanCardDragItem[];
};

type SelectMarqueeOptions = {
  base: KanbanSelectionState;
  rect: ViewportRect;
  mode: MarqueeMode;
};

type RenderedCard = {
  element: Element;
  getItem: () => KanbanCardDragItem;
};

/**
 * One board's card selection. The API object is created once per board and
 * never changes identity; cards subscribe to their own membership, so a
 * selection change re-renders only the cards whose state flipped.
 */
export type KanbanSelection = {
  subscribe: (listener: () => void) => () => void;
  getState: () => KanbanSelectionState;
  isSelected: (entityId: string) => boolean;
  selectCard: (options: SelectCardOptions) => void;
  /** A drag of an unselected card replaces the selection with that card. */
  selectForDrag: (item: KanbanCardDragItem) => void;
  /** Apply a marquee over the cards rendered right now. */
  selectMarquee: (options: SelectMarqueeOptions) => void;
  clear: () => void;
  /** The cards a drag of `primary` carries, `primary` first. */
  getDragItems: (primary: KanbanCardDragItem) => KanbanCardDragItem[];
  /** Make a rendered card reachable by the marquee; returns the cleanup. */
  registerCard: (card: RenderedCard) => () => void;
};

const createKanbanSelection = (): KanbanSelection => {
  const store = createStore(() => EMPTY_STATE);
  const rendered = new Set<RenderedCard>();

  /** Fresh items for rendered cards: a card's lane or name may have moved. */
  const renderedItems = () => {
    const items = new Map<string, KanbanCardDragItem>();
    for (const card of rendered) {
      const item = card.getItem();
      items.set(item.entityId, item);
    }
    return items;
  };

  const commit = (
    next: MultiSelection,
    lookup: ReadonlyMap<string, KanbanCardDragItem>,
  ) => {
    const items = new Map<string, KanbanCardDragItem>();
    for (const entityId of next.selectedIds) {
      const item = lookup.get(entityId);
      if (!item) {
        panic(`Selected kanban card ${entityId} has no drag item`);
      }
      items.set(entityId, item);
    }
    store.setState({ items, anchorId: next.anchorId }, true);
  };

  return {
    subscribe: store.subscribe,
    getState: store.getState,
    isSelected: (entityId) => store.getState().items.has(entityId),
    selectCard: ({ gesture, item, getScope }) => {
      const state = store.getState();
      const scope = gesture === SELECTION_GESTURE.extend ? getScope() : [];
      const lookup = new Map(state.items);
      for (const scoped of scope) {
        lookup.set(scoped.entityId, scoped);
      }
      lookup.set(item.entityId, item);
      commit(
        applySelectionGesture({
          selection: toMultiSelection(state),
          gesture,
          id: item.entityId,
          orderedIds: scope.map((scoped) => scoped.entityId),
        }),
        lookup,
      );
    },
    selectForDrag: (item) => {
      if (store.getState().items.has(item.entityId)) {
        return;
      }
      store.setState(
        { items: new Map([[item.entityId, item]]), anchorId: item.entityId },
        true,
      );
    },
    selectMarquee: ({ base, rect, mode }) => {
      const hits = new Map<string, KanbanCardDragItem>();
      for (const card of rendered) {
        const bounds = card.element.getBoundingClientRect();
        if (rectsIntersect(rect, bounds)) {
          const item = card.getItem();
          hits.set(item.entityId, item);
        }
      }
      const lookup = new Map([...base.items, ...hits]);
      commit(
        applyMarqueeSelection({
          base: toMultiSelection(base),
          hitIds: [...hits.keys()],
          mode,
        }),
        lookup,
      );
    },
    clear: () => {
      if (store.getState().items.size > 0) {
        store.setState(EMPTY_STATE, true);
      }
    },
    getDragItems: (primary) => {
      const fresh = renderedItems();
      const selected = new Map<string, KanbanCardDragItem>();
      for (const [entityId, item] of store.getState().items) {
        selected.set(entityId, fresh.get(entityId) ?? item);
      }
      return getDraggedItems(primary, selected);
    },
    registerCard: (card) => {
      rendered.add(card);
      return () => {
        rendered.delete(card);
      };
    },
  };
};

/**
 * A board's selection, scoped to one view: it survives the board's own
 * re-renders and regrouping, and starts empty when another view is opened in
 * the same board.
 */
export const useKanbanSelectionOwner = (viewId: string): KanbanSelection => {
  const [owned, setOwned] = useState(() => ({
    viewId,
    selection: createKanbanSelection(),
  }));
  if (owned.viewId !== viewId) {
    const next = { viewId, selection: createKanbanSelection() };
    setOwned(next);
    return next.selection;
  }
  return owned.selection;
};

const noopUnsubscribe = (): void => undefined;
const noopSubscribe = () => noopUnsubscribe;
const notSelected = () => false;

/** Whether a card is selected; always `false` on a board without selection. */
export const useIsKanbanCardSelected = (
  selection: KanbanSelection | undefined,
  entityId: string,
): boolean => {
  const getSnapshot = selection
    ? () => selection.isSelected(entityId)
    : notSelected;
  return useSyncExternalStore(
    selection?.subscribe ?? noopSubscribe,
    getSnapshot,
    getSnapshot,
  );
};
