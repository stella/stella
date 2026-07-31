import { lazy, Suspense, useSyncExternalStore } from "react";

const DESKTOP_EDITOR_QUERY = "(min-width: 640px)";

const LazyEditorLiveDemo = lazy(async () => {
  const { EditorLiveDemo } = await import("./EditorLiveDemo");
  return { default: EditorLiveDemo };
});

const subscribeToDesktopViewport = (onStoreChange: () => void) => {
  const query = window.matchMedia(DESKTOP_EDITOR_QUERY);
  query.addEventListener("change", onStoreChange);
  return () => {
    query.removeEventListener("change", onStoreChange);
  };
};

const isDesktopViewport = () => window.matchMedia(DESKTOP_EDITOR_QUERY).matches;

/**
 * Keeps folio's editor bundle and sample DOCX out of mobile sessions. The
 * containing Astro component supplies a static mobile capture, while this
 * shell loads the interactive editor only after the desktop query matches.
 */
export const EditorLiveDemoShell = () => {
  const desktop = useSyncExternalStore(
    subscribeToDesktopViewport,
    isDesktopViewport,
    () => false,
  );

  if (!desktop) {
    return null;
  }

  return (
    <Suspense fallback={null}>
      <LazyEditorLiveDemo />
    </Suspense>
  );
};
