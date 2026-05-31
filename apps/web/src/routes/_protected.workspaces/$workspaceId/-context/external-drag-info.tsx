/**
 * Tracks external file drags (from Finder, Explorer, or another app) into
 * the page, exposing two pieces of info: how many files are being dragged
 * (fileCount), and their MIME types in order (mimeTypes).
 *
 * Two consumers read it:
 *   1. React components call `useExternalDragInfo()`, a `useSyncExternalStore`
 *      hook that re-renders them when the drag payload changes.
 *   2. Pragmatic DnD's `canDrop` callbacks call `getCurrentExternalDrag()`, a
 *      plain synchronous getter. `canDrop` runs outside React's render cycle
 *      and must return synchronously, so it cannot use a hook.
 *
 * How it works:
 *   - Window listeners (dragenter, dragend, drop) update the `current` value.
 *     `dragenter` bubbles up from every nested element during a drag, so
 *     `sameDrag()` short-circuits to avoid re-render storms when the payload
 *     has not actually changed.
 *   - `ExternalDragInfoProvider` does not store state in React; it just owns
 *     the listener lifecycle via `attach` / `detach`. `mountCount`
 *     reference-counts providers so listeners attach once on first mount and
 *     detach on last unmount (safe even if the provider is mounted in
 *     multiple places, e.g. under StrictMode's double-invoke).
 *   - `subscribe` + `getSnapshot` are the `useSyncExternalStore` contract;
 *     that is what makes hook consumers re-render when `notify()` fires.
 */
import type { PropsWithChildren } from "react";
import { useEffect, useSyncExternalStore } from "react";

export type ExternalDragInfo = {
  fileCount: number;
  /** Lowercase MIME types, in DataTransferItem order. */
  mimeTypes: string[];
};

// Module-scoped singleton.
//
// What that means: this state lives as top-level variables in the module,
// not inside a React component or Context value. There is exactly one
// instance per browser tab; the first import evaluates the module, and
// every subsequent import gets the same variables.
//
// Why we need it: Pragmatic DnD's `canDrop` runs outside React's render
// cycle and must return synchronously, so per-row hooks read it directly
// via `getCurrentExternalDrag()`. React state or a Context value could
// not be read synchronously from outside React.
let current: ExternalDragInfo | null = null;
const subscribers = new Set<() => void>();
let mountCount = 0;

const notify = () => {
  for (const cb of subscribers) {
    cb();
  }
};

const sameDrag = (a: ExternalDragInfo, b: ExternalDragInfo): boolean => {
  if (a.fileCount !== b.fileCount) {
    return false;
  }
  if (a.mimeTypes.length !== b.mimeTypes.length) {
    return false;
  }
  for (let i = 0; i < a.mimeTypes.length; i++) {
    if (a.mimeTypes[i] !== b.mimeTypes[i]) {
      return false;
    }
  }
  return true;
};

const onDragEnter = (event: DragEvent) => {
  const dt = event.dataTransfer;
  if (!dt) {
    return;
  }
  const fileItems = Array.from(dt.items).filter((item) => item.kind === "file");
  if (fileItems.length === 0) {
    return;
  }
  const next: ExternalDragInfo = {
    fileCount: fileItems.length,
    mimeTypes: fileItems.map((item) => item.type.toLowerCase()),
  };
  // Bubbling dragenter fires on every nested element; skip notify when the
  // drag payload hasn't changed to avoid re-render storms.
  if (current && sameDrag(current, next)) {
    return;
  }
  current = next;
  notify();
};

const reset = () => {
  if (current === null) {
    return;
  }
  current = null;
  notify();
};

const attach = () => {
  if (mountCount === 0) {
    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragend", reset);
    window.addEventListener("drop", reset);
  }
  mountCount++;
};

const detach = () => {
  mountCount--;
  if (mountCount === 0) {
    window.removeEventListener("dragenter", onDragEnter);
    window.removeEventListener("dragend", reset);
    window.removeEventListener("drop", reset);
    current = null;
  }
};

const subscribe = (cb: () => void) => {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
};

const getSnapshot = () => current;
const getServerSnapshot = (): ExternalDragInfo | null => null;

export const ExternalDragInfoProvider = ({ children }: PropsWithChildren) => {
  useEffect(() => {
    attach();
    return detach;
  }, []);
  return <>{children}</>;
};

/**
 * Subscribes the calling component to external drag state changes.
 * Returns null when no external file drag is in progress.
 */
export const useExternalDragInfo = (): ExternalDragInfo | null =>
  useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

/**
 * Synchronous read of the current external drag info. Intended for use
 * inside Pragmatic DnD `canDrop` callbacks, which fire outside React's
 * render cycle and must return synchronously.
 */
export const getCurrentExternalDrag = (): ExternalDragInfo | null => current;
