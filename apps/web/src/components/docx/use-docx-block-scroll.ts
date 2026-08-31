import { useRef } from "react";
import type { RefObject } from "react";

import type { DocxEditorRef } from "@stll/folio-react";

import { useInspectorCommandStore } from "@/components/inspector/inspector-command-store";
import { useExternalSyncEffect, useMountEffect } from "@/hooks/use-effect";
import { FOLIO_SCROLL_EVENT } from "@/lib/folio-scroll-event";

// A block that is not on screen yet is retried quickly while the editor
// settles, then slowly for as long as a large document takes to load, since
// a tab opened onto a citation has nothing to show until then.
const BLOCK_SCROLL_RETRY_DELAY_MS = 50;
const BLOCK_SCROLL_FAST_RETRY_LIMIT = 20;
const BLOCK_SCROLL_SLOW_RETRY_DELAY_MS = 250;
const BLOCK_SCROLL_RETRY_LIMIT = 60;
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
  const browserWindow = typeof window === "undefined" ? null : window;
  if (browserWindow?.localStorage.getItem(FOLIO_SCROLL_DEBUG_KEY) !== "1") {
    return;
  }

  // eslint-disable-next-line no-console -- localStorage-gated dev scroll diagnostic
  console.info("[folio:scroll]", event, details);
};

export const useDocxBlockScroll = ({
  editorRef,
  fieldId,
}: UseDocxBlockScrollProps) => {
  const pendingBlockScroll = useInspectorCommandStore(
    (s) => s.pendingBlockScroll,
  );
  const clearPendingBlockScroll = useInspectorCommandStore(
    (s) => s.clearPendingBlockScroll,
  );

  // The request currently being served, by `seq`. A request is served exactly
  // once — and every request is served, including a repeat of the block the
  // reader is already parked on, because each carries a fresh `seq`.
  const servedSeqRef = useRef<number | null>(null);
  // The schedule is cancelled by the next request or by unmount, never by this
  // effect's own cleanup: acknowledging a scroll clears the store, which would
  // otherwise re-run the effect and cancel the settle passes that make the
  // landing stick on a document still laying itself out.
  const cancelScrollRef = useRef<(() => void) | null>(null);

  useMountEffect(() => () => {
    cancelScrollRef.current?.();
  });

  useExternalSyncEffect(() => {
    if (
      pendingBlockScroll === null ||
      pendingBlockScroll.tabId !== fieldId ||
      servedSeqRef.current === pendingBlockScroll.seq
    ) {
      return;
    }
    const { blockId, seq, text } = pendingBlockScroll;
    servedSeqRef.current = seq;

    debugDocxBlockScroll("hook:pending", { blockId, fieldId, seq });

    cancelScrollRef.current?.();
    cancelScrollRef.current = scheduleDocxBlockScroll({
      blockId,
      text,
      onSuccess: () => {
        clearPendingBlockScroll(seq);
      },
      attemptScroll: (target) => attemptDocxScroll(editorRef, target),
    });
  }, [clearPendingBlockScroll, editorRef, fieldId, pendingBlockScroll]);

  useExternalSyncEffect(() => {
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
      // Targeted events name the editor they address; ignore events
      // for other fields so a positional `seq-NNNN` id cannot resolve
      // (and highlight) in an unrelated mounted editor. Events without
      // a fieldId are legacy broadcasts from dispatchers that cannot
      // know the owner.
      const rawFieldId: unknown =
        "fieldId" in detail ? detail.fieldId : undefined;
      const targeted = typeof rawFieldId === "string" && rawFieldId.length > 0;
      if (targeted && rawFieldId !== fieldId) {
        return;
      }
      // Optional passage text: a non-string / empty value is absent,
      // not an error — the target simply falls back to scroll-only.
      // Broadcasts stay scroll-only regardless: a passage highlight
      // must never paint in an editor the dispatcher didn't name.
      const rawText: unknown = "text" in detail ? detail.text : undefined;
      const text =
        targeted && typeof rawText === "string" && rawText.length > 0
          ? rawText
          : undefined;

      debugDocxBlockScroll("hook:event", {
        blockId,
        fieldId,
      });

      // One scroll in flight per editor, whichever path asked for it: a
      // broadcast and a queued command racing each other would land the
      // reader on whichever block finished retrying last.
      cancelScrollRef.current?.();
      cancelScrollRef.current = scheduleDocxBlockScroll({
        blockId,
        text,
        attemptScroll: (target) => attemptDocxScroll(editorRef, target),
      });
    };

    window.addEventListener(FOLIO_SCROLL_EVENT, handler);
    return () => {
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
      retryTimer = setTimeout(
        tryScroll,
        attempts < BLOCK_SCROLL_FAST_RETRY_LIMIT
          ? BLOCK_SCROLL_RETRY_DELAY_MS
          : BLOCK_SCROLL_SLOW_RETRY_DELAY_MS,
      );
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
