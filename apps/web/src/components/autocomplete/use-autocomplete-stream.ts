import { useLayoutEffect } from "react";
import type { RefObject } from "react";

import type { EditorView } from "@tiptap/pm/view";

import { fetchWithTimeout } from "@stll/fetch";

import type { DocxEditorRef } from "@/components/docx/app-docx-editor";
import { getAnalytics } from "@/lib/analytics/provider";
import { apiUrl } from "@/lib/api-url";
import { detached } from "@/lib/detached";
import { readSSEEvents } from "@/lib/sse-events";
import { createUuid } from "@/lib/uuid";

import { runAutocompleteRequest } from "./use-autocomplete-stream.logic";

export type UseAutocompleteStreamOptions = {
  enabled: boolean;
  debounceMs?: number;
  minPrefixChars?: number;
  language?: string;
};

const DEFAULT_DEBOUNCE_MS = 1500;
const DEFAULT_MIN_PREFIX_CHARS = 8;
const MAX_PREFIX_CHARS = 8000;
const MAX_SUFFIX_CHARS = 4000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const readStringField = (data: string, field: string): string | null => {
  try {
    const payload: unknown = JSON.parse(data);
    if (!isRecord(payload)) {
      return null;
    }
    const value = payload[field];
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
};

const extractAutocompleteContext = (
  view: EditorView,
): { prefix: string; suffix: string; anchor: number } => {
  // The editor starts the suggestion at the caret, as read here.
  const { state } = view;
  const anchor = state.selection.from;
  const fullPrefix = state.doc.textBetween(0, anchor, "\n", "\n");
  const fullSuffix = state.doc.textBetween(
    anchor,
    state.doc.content.size,
    "\n",
    "\n",
  );
  const prefix = fullPrefix.slice(-MAX_PREFIX_CHARS);
  const suffix = fullSuffix.slice(0, MAX_SUFFIX_CHARS);
  return { prefix, suffix, anchor };
};

type StreamCallbacks = {
  onToken: (text: string) => boolean;
  onError: () => void;
  onDone: () => void;
};

const consumeAutocompleteStream = async (
  body: ReadableStream<Uint8Array>,
  cb: StreamCallbacks,
): Promise<void> => {
  const outcome = await readSSEEvents(body, (event) => {
    if (event.event === "token") {
      const text = readStringField(event.data, "text");
      if (text === null || text.length === 0) {
        return true;
      }
      return cb.onToken(text);
    }
    if (event.event === "error") {
      cb.onError();
      return false;
    }
    if (event.event === "done") {
      cb.onDone();
      return false;
    }
    return true;
  });
  // A body that ended without a terminal frame still finishes the suggestion:
  // what streamed is what the model wrote.
  if (outcome === "drained") {
    cb.onDone();
  }
};

/**
 * Stream the backend's suggestion into folio's inline autocomplete
 * (`DocxEditorRef.autocomplete`).
 *
 * Subscribes to transactions on the given `view`. A suggestion never
 * changes the document, so every document change is an edit: it cancels
 * any in-flight request and (re)schedules a debounced trigger. When the
 * debounce expires and the caret fits a suggestion (`canTrigger`), it
 * fetches `/v1/ai-autocomplete/stream` and appends each token.
 */
export const useAutocompleteStream = ({
  editorRef,
  view,
  ...options
}: UseAutocompleteStreamOptions & {
  editorRef: RefObject<DocxEditorRef | null>;
  view: EditorView | null;
}): void => {
  const {
    debounceMs = DEFAULT_DEBOUNCE_MS,
    enabled,
    language,
    minPrefixChars = DEFAULT_MIN_PREFIX_CHARS,
  } = options;

  useLayoutEffect(() => {
    const noop = () => {
      /* nothing to clean up */
    };
    if (view === null) {
      return noop;
    }
    if (!enabled) {
      return noop;
    }

    const aliveRef = { value: true };

    let inflight: AbortController | null = null;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let lastSignature = "";

    const cancelInflight = () => {
      if (inflight !== null) {
        inflight.abort();
        inflight = null;
      }
    };

    // The editor's suggestion, while this hook still drives it.
    const live = () =>
      aliveRef.value && !view.isDestroyed
        ? (editorRef.current?.autocomplete ?? null)
        : null;

    const fireRequest = async () => {
      const autocomplete = live();
      if (autocomplete === null) {
        return;
      }
      if (autocomplete.get().status !== "idle") {
        return;
      }
      if (!autocomplete.canTrigger()) {
        return;
      }
      const { prefix, suffix, anchor } = extractAutocompleteContext(view);
      if (prefix.length < minPrefixChars) {
        return;
      }
      const signature = `${anchor}:${prefix.length}:${prefix.slice(-32)}:${suffix.length}:${suffix.slice(0, 32)}`;
      if (signature === lastSignature) {
        return;
      }
      lastSignature = signature;

      cancelInflight();
      const controller = new AbortController();
      inflight = controller;
      const requestId = createUuid();

      // Settles every outcome itself (it never rejects), so the in-flight
      // slot is released right after it.
      await runAutocompleteRequest({
        controller,
        dispatchStart: () => live()?.start({ requestId }) === requestId,
        fetchResponse: async () =>
          await fetchWithTimeout(apiUrl("/ai-autocomplete/stream"), {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              prefix,
              suffix: suffix.length > 0 ? suffix : undefined,
              language,
            }),
            signal: controller.signal,
            timeoutMs: 15_000,
          }),
        consume: async (body) =>
          await consumeAutocompleteStream(body, {
            onToken: (text) => live()?.append(requestId, text) ?? false,
            onError: () => {
              live()?.clear();
            },
            onDone: () => {
              live()?.finish(requestId);
            },
          }),
        clear: () => {
          live()?.clear();
        },
        reportError: (error) => {
          getAnalytics().captureError(error, {
            fingerprintKey:
              "useAutocompleteStream.fireRequest.reportError:failure",
            scope: {
              type: "request",
              method: "POST",
              routeTemplate: "/v1/ai-autocomplete/stream",
            },
          });
        },
      });
      if (inflight === controller) {
        inflight = null;
      }
    };

    const scheduleTrigger = () => {
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = setTimeout(() => {
        detached(fireRequest(), "use-autocomplete-stream.fire-request");
      }, debounceMs);
    };

    // PM doesn't expose a public "subscribe to transactions"
    // hook, so we install a dispatch wrapper. Every doc edit
    // cancels the in-flight request and (re)schedules a new
    // trigger.
    const originalDispatchTransaction = view.props.dispatchTransaction;
    const restoreDispatchTransaction = () => {
      if (view.isDestroyed) {
        return;
      }
      if (originalDispatchTransaction) {
        view.setProps({ dispatchTransaction: originalDispatchTransaction });
        return;
      }

      const nextProps = { ...view.props, state: view.state };
      delete nextProps.dispatchTransaction;
      view.update(nextProps);
    };
    view.setProps({
      dispatchTransaction: (tr) => {
        if (originalDispatchTransaction) {
          originalDispatchTransaction.call(view, tr);
        } else {
          view.updateState(view.state.apply(tr));
        }
        if (tr.docChanged) {
          cancelInflight();
          scheduleTrigger();
        }
      },
    });

    return () => {
      aliveRef.value = false;
      cancelInflight();
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
      }
      restoreDispatchTransaction();
    };
  }, [editorRef, view, enabled, debounceMs, language, minPrefixChars]);
};
