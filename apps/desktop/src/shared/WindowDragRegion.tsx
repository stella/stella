import { detectDesktopPlatform } from "./shortcut-keys";

const MAC = detectDesktopPlatform(navigator.userAgent) === "mac";

/**
 * The strip a window that hides its macOS title bar is moved by. The page
 * covers the native title bar, so without it the window cannot be dragged.
 * Every page shell already keeps this strip clear of controls. The window's
 * capability grants `core:window:allow-start-dragging`; the window
 * capabilities test holds both together.
 */
export const WindowDragRegion = () =>
  MAC ? (
    <div
      aria-hidden="true"
      className="fixed inset-x-0 top-0 z-50 h-7"
      data-slot="window-drag-region"
      data-tauri-drag-region
    />
  ) : null;
