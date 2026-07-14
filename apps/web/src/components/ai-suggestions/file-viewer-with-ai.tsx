import { lazy, Suspense, useCallback } from "react";

import { cn } from "@stll/ui/lib/utils";

import type { FileViewerWithAIProps } from "./file-viewer-with-ai.impl";

// The actual implementation pulls in `host.tsx`, `file-chat-overlay.tsx`,
// and ultimately `@stll/folio-react`'s AI-suggestion helpers (applySuggestions,
// resolveSuggestionAnchor, citation/decoration meta setters). Keeping
// it behind `lazy()` is what stops the Folio editor + Yjs + utif2 graph
// (~490 KB gz) from being preloaded on the homepage. The wrapper just
// keeps the file viewer mounted while the AI overlay chunk is in flight,
// so the visible viewer never pauses or remounts for AI bytes.
const LazyFileChatOverlayHost = lazy(async () => {
  const m = await import("./file-viewer-with-ai.impl");
  return { default: m.FileChatOverlayHost };
});

export const FileViewerWithAI = ({
  workspaceId,
  chatThreadId,
  activeFile,
  activeExternal,
  className,
  docxEditable,
  docxEditorRef,
  docxComments,
  onDocxCommentsChange,
  requestDocxEditMode,
  children,
}: FileViewerWithAIProps) => {
  const overlayKey = [
    chatThreadId ?? "mapped-file-chat",
    workspaceId ?? "",
    activeFile?.entityId ?? "",
    activeFile?.fileFieldId ?? "",
    activeExternal?.url ?? "",
  ].join(":");

  return (
    <div
      className={cn("relative h-full w-full", className)}
      data-file-viewer-ai="true"
    >
      {children}
      <Suspense fallback={null}>
        <LazyFileChatOverlayHost
          activeExternal={activeExternal}
          activeFile={activeFile}
          chatThreadId={chatThreadId}
          docxComments={docxComments}
          docxEditable={docxEditable}
          docxEditorRef={docxEditorRef}
          key={overlayKey}
          onDocxCommentsChange={onDocxCommentsChange}
          requestDocxEditMode={requestDocxEditMode}
          workspaceId={workspaceId}
        />
      </Suspense>
      {docxEditorRef !== undefined && <DocxHorizontalScrollbar />}
    </div>
  );
};

const DocxHorizontalScrollbar = () => {
  const trackRef = useCallback((track: HTMLDivElement | null) => {
    if (!track?.parentElement) {
      return;
    }

    const host = track.parentElement;
    const thumb = track.firstElementChild;
    if (!(thumb instanceof HTMLDivElement)) {
      return;
    }

    let scrollElement: HTMLElement | null = null;
    let scrollCleanup = () => undefined;
    let pointerCleanup = () => undefined;

    const updateThumb = () => {
      if (!scrollElement) {
        track.hidden = true;
        return;
      }

      const maxScroll = scrollElement.scrollWidth - scrollElement.clientWidth;
      track.hidden = maxScroll <= 1;
      if (maxScroll <= 1) {
        return;
      }

      const thumbWidth = Math.max(
        (scrollElement.clientWidth / scrollElement.scrollWidth) *
          track.clientWidth,
        24,
      );
      const travel = Math.max(track.clientWidth - thumbWidth, 0);
      const progress = Math.min(
        Math.max(scrollElement.scrollLeft / maxScroll, 0),
        1,
      );
      thumb.style.width = `${String(thumbWidth)}px`;
      thumb.style.transform = `translateX(${String(progress * travel)}px)`;
    };

    const bindScrollElement = () => {
      const nextScrollElement = host.querySelector<HTMLElement>(
        "[data-folio-scroll]",
      );
      if (nextScrollElement === scrollElement) {
        updateThumb();
        return;
      }

      scrollCleanup();
      scrollElement = nextScrollElement;
      if (!scrollElement) {
        track.hidden = true;
        scrollCleanup = () => undefined;
        return;
      }

      const boundScrollElement = scrollElement;
      const previousOverflowX = boundScrollElement.style.overflowX;
      boundScrollElement.style.overflowX = "hidden";

      const resizeObserver = new ResizeObserver(updateThumb);
      resizeObserver.observe(boundScrollElement);
      resizeObserver.observe(track);
      boundScrollElement.addEventListener("scroll", updateThumb, {
        passive: true,
      });
      const handleWheel = (event: WheelEvent) => {
        let horizontalDelta = 0;
        if (event.shiftKey) {
          horizontalDelta = event.deltaY;
        } else if (Math.abs(event.deltaX) >= Math.abs(event.deltaY)) {
          horizontalDelta = event.deltaX;
        }
        if (horizontalDelta === 0) {
          return;
        }

        const maxScroll =
          boundScrollElement.scrollWidth - boundScrollElement.clientWidth;
        const nextScrollLeft = Math.min(
          Math.max(boundScrollElement.scrollLeft + horizontalDelta, 0),
          maxScroll,
        );
        if (nextScrollLeft === boundScrollElement.scrollLeft) {
          return;
        }

        event.preventDefault();
        boundScrollElement.scrollLeft = nextScrollLeft;
      };
      // eslint-disable-next-line github/require-passive-events -- horizontal wheel interception calls preventDefault; passive: false is required and set
      boundScrollElement.addEventListener("wheel", handleWheel, {
        passive: false,
      });
      updateThumb();
      scrollCleanup = () => {
        resizeObserver.disconnect();
        boundScrollElement.removeEventListener("scroll", updateThumb);
        boundScrollElement.removeEventListener("wheel", handleWheel);
        boundScrollElement.style.overflowX = previousOverflowX;
      };
    };

    const mutationObserver = new MutationObserver(bindScrollElement);
    mutationObserver.observe(host, { childList: true, subtree: true });
    bindScrollElement();

    const setScrollFromPointer = (clientX: number, grabOffset: number) => {
      if (!scrollElement) {
        return;
      }
      const maxScroll = scrollElement.scrollWidth - scrollElement.clientWidth;
      const trackRect = track.getBoundingClientRect();
      const thumbWidth = thumb.getBoundingClientRect().width;
      const travel = Math.max(trackRect.width - thumbWidth, 1);
      const thumbStart = Math.min(
        Math.max(clientX - trackRect.left - grabOffset, 0),
        travel,
      );
      scrollElement.scrollLeft = (thumbStart / travel) * maxScroll;
    };

    const handlePointerDown = (event: PointerEvent) => {
      if (!scrollElement) {
        return;
      }
      pointerCleanup();
      event.preventDefault();
      const thumbRect = thumb.getBoundingClientRect();
      const grabbedThumb = event.target === thumb;
      const grabOffset = grabbedThumb
        ? event.clientX - thumbRect.left
        : thumbRect.width / 2;
      track.setPointerCapture(event.pointerId);
      setScrollFromPointer(event.clientX, grabOffset);

      const handlePointerMove = (moveEvent: PointerEvent) => {
        setScrollFromPointer(moveEvent.clientX, grabOffset);
      };
      const handlePointerUp = (upEvent: PointerEvent) => {
        if (track.hasPointerCapture(upEvent.pointerId)) {
          track.releasePointerCapture(upEvent.pointerId);
        }
        pointerCleanup();
      };
      pointerCleanup = () => {
        track.removeEventListener("pointermove", handlePointerMove);
        track.removeEventListener("pointerup", handlePointerUp);
        track.removeEventListener("pointercancel", handlePointerUp);
      };
      track.addEventListener("pointermove", handlePointerMove);
      track.addEventListener("pointerup", handlePointerUp);
      track.addEventListener("pointercancel", handlePointerUp);
    };

    track.addEventListener("pointerdown", handlePointerDown);
    return () => {
      mutationObserver.disconnect();
      scrollCleanup();
      pointerCleanup();
      track.removeEventListener("pointerdown", handlePointerDown);
    };
  }, []);

  return (
    <div
      ref={trackRef}
      aria-hidden="true"
      className="absolute inset-x-1 bottom-1 z-[100] h-1.5 cursor-pointer"
      dir="ltr"
      hidden
    >
      <div className="bg-foreground/20 absolute inset-y-0 start-0 rounded-full" />
    </div>
  );
};
