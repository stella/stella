import { useExternalSyncEffect } from "@stll/ui/effects";

const carriesFiles = (event: DragEvent) =>
  event.dataTransfer?.types.includes("Files") === true;

/**
 * Keeps a file dragged in from the desktop from falling through to the
 * browser. A drop that no drop zone claims would otherwise be the browser's:
 * Chrome downloads a .docx dropped beside the composer and navigates away to
 * a PDF. The listeners sit on the window in the bubble phase, so every drop
 * zone (React handlers, pragmatic-drag-and-drop's capture-phase adapter, the
 * editor) has already had the event; only one nobody cancelled is touched.
 * The `none` drop effect shows the not-allowed cursor there instead of a
 * copy cursor that promises a drop that would do nothing.
 */
export const installStrayFileDropGuard = (target: Window) => {
  const handleDragOver = (event: DragEvent) => {
    if (event.defaultPrevented || !carriesFiles(event)) {
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "none";
    }
  };
  const handleDrop = (event: DragEvent) => {
    if (event.defaultPrevented || !carriesFiles(event)) {
      return;
    }
    event.preventDefault();
  };
  target.addEventListener("dragover", handleDragOver);
  target.addEventListener("drop", handleDrop);
  return () => {
    target.removeEventListener("dragover", handleDragOver);
    target.removeEventListener("drop", handleDrop);
  };
};

/** Mounts {@link installStrayFileDropGuard} for the app's lifetime. */
export const StrayFileDropGuard = () => {
  useExternalSyncEffect(() => installStrayFileDropGuard(window), []);
  return null;
};
