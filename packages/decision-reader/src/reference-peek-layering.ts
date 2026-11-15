import { useSyncExternalStore } from "react";

/**
 * The one layering rule between peeks and the floating bar over selected
 * text: the selection toolbar wins. While any selection toolbar is on
 * screen no peek opens, from hover, focus or a click, and a peek that was
 * open closes. Once the toolbar is gone a peek opens again only on a new
 * gesture; one cut short never comes back by itself. The two never overlap,
 * and whoever selected text to act on it keeps the bar they asked for.
 *
 * The toolbar holds the peeks for as long as it is mounted
 * (`holdReferencePeeks`); every peek reads the hold through
 * `useReferencePeekEpoch`. Nothing else decides the order.
 */

/** A peek opens in an epoch and stays open only while that epoch lasts. */
export type ReferencePeekEpoch = number;

type PeekLayer = { holds: number; epoch: ReferencePeekEpoch };

let layer: PeekLayer = { holds: 0, epoch: 0 };
const listeners = new Set<() => void>();

const publish = (next: PeekLayer) => {
  layer = next;
  for (const listener of listeners) {
    listener();
  }
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** The current epoch, or null while a selection toolbar holds every peek. */
const snapshot = (): ReferencePeekEpoch | null =>
  layer.holds > 0 ? null : layer.epoch;

/**
 * Holds every peek closed until the returned release runs. Each hold starts
 * a new epoch, so a peek open before it stays closed after it.
 */
export const holdReferencePeeks = (): (() => void) => {
  publish({ holds: layer.holds + 1, epoch: layer.epoch + 1 });
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    publish({ holds: layer.holds - 1, epoch: layer.epoch });
  };
};

export const useReferencePeekEpoch = (): ReferencePeekEpoch | null =>
  useSyncExternalStore(subscribe, snapshot, () => 0);
