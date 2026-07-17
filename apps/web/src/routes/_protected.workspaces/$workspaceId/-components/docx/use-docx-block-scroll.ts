import type { RefObject } from "react";

import type { DocxEditorRef } from "@stll/folio-react";

import { useExternalSyncEffect } from "@/hooks/use-effect";
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

type DocxScrollTarget = { blockId: string; text?: string | undefined };

type ScheduleDocxBlockScrollProps = {
  blockId: string;
  text?: string | undefined;
  onSuccess?: (() => void) | undefined;
  attemptScroll: (target: DocxScrollTarget) => boolean | undefined;
};

/**
 * Land the user on a citation target. With passage `text`, ask folio
 * for a persistent exact-passage highlight and treat both `"passage"`
 * (text matched) and `"block"` (text drifted, degraded to a block
 * flash) as success; only `"none"` (block didn't resolve) is a miss
 * worth retrying. Without `text`, fall back to a plain scroll. Returns
 * `undefined` while the editor ref is still unmounted so the caller
 * keeps retrying.
 */
const attemptDocxScroll = (
  editorRef: RefObject<DocxEditorRef | null>,
  { blockId, text }: DocxScrollTarget,
): boolean | undefined => {
  const editor = editorRef.current;
  if (!editor) {
    return undefined;
  }
  if (typeof text === "string" && text.length > 0) {
    return editor.highlightPassage({ blockId, text }) !== "none";
  }
  return editor.scrollToBlock(blockId);
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

  // eslint-disable-next-line no-console -- localStorage-gated dev scroll diagnostic
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

  useExternalSyncEffect(() => {
    if (pendingBlockScroll === null || pendingBlockScroll.tabId !== fieldId) {
      return undefined;
    }

    debugDocxBlockScroll("hook:pending", {
      blockId: pendingBlockScroll.blockId,
      fieldId,
    });

    return scheduleDocxBlockScroll({
      blockId: pendingBlockScroll.blockId,
      text: pendingBlockScroll.text,
      onSuccess: clearPendingBlockScroll,
      attemptScroll: (target) => attemptDocxScroll(editorRef, target),
    });
  }, [clearPendingBlockScroll, editorRef, fieldId, pendingBlockScroll]);

  useExternalSyncEffect(() => {
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
      const blockId: unknown = "blockId" in detail ? detail.blockId : undefined;
      if (typeof blockId !== "string" || blockId.length === 0) {
        return;
      }
      // Optional passage text: a non-string / empty value is absent,
      // not an error — the target simply falls back to scroll-only.
      const rawText: unknown = "text" in detail ? detail.text : undefined;
      const text =
        typeof rawText === "string" && rawText.length > 0 ? rawText : undefined;

      debugDocxBlockScroll("hook:event", {
        blockId,
        fieldId,
      });

      cancelScroll?.();
      cancelScroll = scheduleDocxBlockScroll({
        blockId,
        text,
        attemptScroll: (target) => attemptDocxScroll(editorRef, target),
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
  text,
  onSuccess,
  attemptScroll,
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

      const ok = attemptScroll({ blockId, text });
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

    const ok = attemptScroll({ blockId, text });
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
