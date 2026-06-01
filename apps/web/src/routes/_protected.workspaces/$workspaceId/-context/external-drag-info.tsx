/**
 * Tracks external file drags into the page, exposing how many files are
 * being dragged and their MIME types.
 *
 * Why this exists: Pragmatic DnD's `canDrop` callback does not surface
 * per-file MIME types or counts on its `source` argument, so we read
 * `dataTransfer.items` ourselves off the raw DOM `dragenter` event and
 * stash the result where `canDrop` can read it synchronously.
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

// Capture phase: guarantees these run before any descendant or other
// window-level bubble-phase listener (including Pragmatic DnD's), so
// `current` is populated before any `canDrop` reads it. Without this,
// ordering would depend on listener registration order.
const LISTENER_OPTIONS = { capture: true } as const;

const attach = () => {
  if (mountCount === 0) {
    window.addEventListener("dragenter", onDragEnter, LISTENER_OPTIONS);
    window.addEventListener("dragend", reset, LISTENER_OPTIONS);
    window.addEventListener("drop", reset, LISTENER_OPTIONS);
  }
  mountCount++;
};

const detach = () => {
  mountCount--;
  if (mountCount === 0) {
    window.removeEventListener("dragenter", onDragEnter, LISTENER_OPTIONS);
    window.removeEventListener("dragend", reset, LISTENER_OPTIONS);
    window.removeEventListener("drop", reset, LISTENER_OPTIONS);
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
 * inside Pragmatic DnD `canDrop` callbacks: `canDrop` runs outside
 * React's render cycle and must return synchronously, so it cannot use
 * a hook.
 */
export const getCurrentExternalDrag = (): ExternalDragInfo | null => current;
