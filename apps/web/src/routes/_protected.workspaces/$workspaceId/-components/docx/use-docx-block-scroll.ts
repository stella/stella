import { useEffect } from "react";
import type { RefObject } from "react";

import { isFolioBlockId } from "@stll/folio";
import type { DocxEditorRef, FolioBlockId } from "@stll/folio";

import { FOLIO_SCROLL_EVENT } from "@/lib/folio-scroll-event";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";

const BLOCK_SCROLL_RETRY_DELAY_MS = 50;
const BLOCK_SCROLL_RETRY_LIMIT = 20;
const BLOCK_SCROLL_SETTLE_DELAY_MS = 180;
const BLOCK_SCROLL_SETTLE_ATTEMPTS = 2;
const FOLIO_SCROLL_DEBUG_KEY = "folio:debug-scroll";

type UseDocxBlockScrollProps = {
  editorRef: RefObject<DocxEditorRef | null>;
  fieldId: string;
};

type ScheduleDocxBlockScrollProps = {
  blockId: FolioBlockId;
  onSuccess?: (() => void) | undefined;
  scrollToBlock: (blockId: FolioBlockId) => boolean | undefined;
};

const debugDocxBlockScroll = (
  event: string,
  details: Record<string, unknown>,
) => {
  if (
    typeof window === "undefined" ||
    window.localStorage.getItem(FOLIO_SCROLL_DEBUG_KEY) !== "1"
  ) {
    return;
  }

  // eslint-disable-next-line no-console
  console.info("[folio:scroll]", event, details);
};

export const useDocxBlockScroll = ({
  editorRef,
  fieldId,
}: UseDocxBlockScrollProps) => {
  const pendingBlockScroll = useInspectorStore((s) => s.pendingBlockScroll);
  const clearPendingBlockScroll = useInspectorStore(
    (s) => s.clearPendingBlockScroll,
  );

  useEffect(() => {
    if (pendingBlockScroll === null || pendingBlockScroll.tabId !== fieldId) {
      return undefined;
    }

    debugDocxBlockScroll("hook:pending", {
      blockId: pendingBlockScroll.blockId,
      fieldId,
    });

    return scheduleDocxBlockScroll({
      blockId: pendingBlockScroll.blockId,
      onSuccess: clearPendingBlockScroll,
      scrollToBlock: (blockId) => editorRef.current?.scrollToBlock(blockId),
    });
  }, [clearPendingBlockScroll, editorRef, fieldId, pendingBlockScroll]);

  useEffect(() => {
    let cancelScroll: (() => void) | null = null;

    // `FOLIO_SCROLL_EVENT` isn't in the WindowEventMap because it's
    // a custom in-app channel; receive Event and narrow inside.
    const handler: EventListener = (event) => {
      if (!(event instanceof CustomEvent)) {
        return;
      }
      const detail: unknown = event.detail;
      if (typeof detail !== "object" || detail === null) {
        return;
      }
      const blockId: unknown = (detail as { blockId?: unknown }).blockId;
      if (!isFolioBlockId(blockId)) {
        return;
      }

      debugDocxBlockScroll("hook:event", {
        blockId,
        fieldId,
      });

      cancelScroll?.();
      cancelScroll = scheduleDocxBlockScroll({
        blockId,
        scrollToBlock: (id) => editorRef.current?.scrollToBlock(id),
      });
    };

    window.addEventListener(FOLIO_SCROLL_EVENT, handler);
    return () => {
      cancelScroll?.();
      window.removeEventListener(FOLIO_SCROLL_EVENT, handler);
    };
  }, [editorRef, fieldId]);
};

const scheduleDocxBlockScroll = ({
  blockId,
  onSuccess,
  scrollToBlock,
}: ScheduleDocxBlockScrollProps) => {
  let cancelled = false;
  let attempts = 0;
  let settledAttempts = 0;
  let didNotifySuccess = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const notifySuccess = () => {
    if (didNotifySuccess) {
      return;
    }
    didNotifySuccess = true;
    onSuccess?.();
  };

  const settleScroll = () => {
    notifySuccess();
    if (settledAttempts >= BLOCK_SCROLL_SETTLE_ATTEMPTS) {
      return;
    }

    settledAttempts += 1;
    retryTimer = setTimeout(() => {
      if (cancelled) {
        return;
      }

      const ok = scrollToBlock(blockId);
      if (ok === true) {
        settleScroll();
        return;
      }

      attempts = 0;
      tryScroll();
    }, BLOCK_SCROLL_SETTLE_DELAY_MS);
  };

  const tryScroll = () => {
    if (cancelled) {
      return;
    }

    const ok = scrollToBlock(blockId);
    debugDocxBlockScroll("hook:try", {
      attempts,
      blockId,
      ok,
      settledAttempts,
    });
    if (ok === true) {
      settleScroll();
      return;
    }

    attempts += 1;
    if (attempts < BLOCK_SCROLL_RETRY_LIMIT) {
      retryTimer = setTimeout(tryScroll, BLOCK_SCROLL_RETRY_DELAY_MS);
    }
  };

  tryScroll();

  return () => {
    cancelled = true;
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
    }
  };
};
