// The event half of the headless editor controller (seam-architecture Seam 6:
// `FolioEditor`). Framework adapters subscribe here instead of threading prop
// callbacks, and a desktop/headless host can observe the same stream. Kept as a
// small typed emitter with no ProseMirror/React/DOM dependency so it stays
// portable across hosts.

import type { Layout } from "../layout-engine/types";
import type { Document } from "../types/document";

export type FolioSelectionEvent = {
  from: number;
  to: number;
};

// The payload for each editor event. Add events here as the controller grows
// (e.g. `focusChange`, `error`); adapters get the new event typed for free.
export type FolioEditorEventMap = {
  selectionChange: FolioSelectionEvent;
  docChange: Document;
  layoutComplete: Layout;
};

export type FolioEditorEventName = keyof FolioEditorEventMap;

export type FolioEditorEventListener<K extends FolioEditorEventName> = (
  payload: FolioEditorEventMap[K],
) => void;

export type FolioEditorEmitter = {
  /** Subscribe to an event. Returns an unsubscribe function. */
  on: <K extends FolioEditorEventName>(
    event: K,
    listener: FolioEditorEventListener<K>,
  ) => () => void;
  /** Emit an event to all current listeners. */
  emit: <K extends FolioEditorEventName>(
    event: K,
    payload: FolioEditorEventMap[K],
  ) => void;
  /** Drop all listeners (call on controller teardown). */
  clear: () => void;
};

export const createFolioEditorEmitter = (): FolioEditorEmitter => {
  // One listener set per event name. A mapped-type record (rather than a Map)
  // keeps the key↔payload correlation: indexing `channels[event]` by a generic
  // `K` resolves to `Set<FolioEditorEventListener<K>>`, so `on`/`emit` stay
  // fully typed with no casts.
  const channels: {
    [K in FolioEditorEventName]: Set<FolioEditorEventListener<K>>;
  } = {
    selectionChange: new Set(),
    docChange: new Set(),
    layoutComplete: new Set(),
  };

  return {
    on: (event, listener) => {
      channels[event].add(listener);
      return () => {
        channels[event].delete(listener);
      };
    },

    emit: (event, payload) => {
      // Snapshot so a listener that unsubscribes mid-emit doesn't perturb the
      // iteration.
      for (const listener of [...channels[event]]) {
        listener(payload);
      }
    },

    clear: () => {
      for (const channel of Object.values(channels)) {
        channel.clear();
      }
    },
  };
};
