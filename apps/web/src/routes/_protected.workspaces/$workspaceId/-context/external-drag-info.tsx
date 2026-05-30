import { useEffect, useSyncExternalStore } from "react";
import type { PropsWithChildren } from "react";

export type ExternalDragInfo = {
  fileCount: number;
  /** Lowercase MIME types, in DataTransferItem order. */
  mimeTypes: string[];
};

// Module-scoped singleton. Pragmatic DnD's `canDrop` runs outside React's
// render cycle and must return synchronously, so per-row hooks read this
// directly via `getCurrentExternalDrag()`. The Provider only manages the
// window listener lifecycle and re-renders for hook consumers.
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
  mountCount += 1;
};

const detach = () => {
  mountCount -= 1;
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
