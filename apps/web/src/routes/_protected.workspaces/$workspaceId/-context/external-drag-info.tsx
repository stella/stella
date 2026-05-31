/**
 * Tracks external file drags into the page, exposing how many files are
 * being dragged and their MIME types.
 *
 * Pragmatic DnD's `canDrop` callbacks read this via
 * `getCurrentExternalDrag()`, a plain synchronous getter. `canDrop` runs
 * outside React's render cycle and must return synchronously, so it
 * cannot use a hook.
 *
 * Notes:
 *   - Window listeners (dragenter, dragend, drop) update `current`.
 *     `dragenter` bubbles up from every nested element, so it rewrites
 *     `current` many times per drag; the write is cheap and nothing
 *     subscribes.
 *   - `ExternalDragInfoProvider` owns the listener lifecycle via
 *     `attach` / `detach`. `mountCount` reference-counts providers so
 *     listeners attach once and detach when the last provider unmounts
 *     (safe under StrictMode's double-invoke).
 */
import type { PropsWithChildren } from "react";
import { useEffect } from "react";

export type ExternalDragInfo = {
  fileCount: number;
  /** Lowercase MIME types, in DataTransferItem order. */
  mimeTypes: string[];
};

// Module-scoped singleton: top-level variable in this module, not React
// state or a Context value. One instance per browser tab; every import
// gets the same variable. We need this shape because React state or a
// Context value could not be read synchronously from `canDrop`.
let current: ExternalDragInfo | null = null;
let mountCount = 0;

const onDragEnter = (event: DragEvent) => {
  const dt = event.dataTransfer;
  if (!dt) {
    return;
  }
  const fileItems = Array.from(dt.items).filter((item) => item.kind === "file");
  if (fileItems.length === 0) {
    return;
  }
  current = {
    fileCount: fileItems.length,
    mimeTypes: fileItems.map((item) => item.type.toLowerCase()),
  };
};

const reset = () => {
  current = null;
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

export const ExternalDragInfoProvider = ({ children }: PropsWithChildren) => {
  useEffect(() => {
    attach();
    return detach;
  }, []);
  return <>{children}</>;
};

/**
 * Synchronous read of the current external drag info. Intended for use
 * inside Pragmatic DnD `canDrop` callbacks.
 */
export const getCurrentExternalDrag = (): ExternalDragInfo | null => current;
