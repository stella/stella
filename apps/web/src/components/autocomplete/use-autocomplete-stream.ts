import { useLayoutEffect } from "react";

import type { Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";

import {
  appendAutocompleteToken,
  autocompleteSuggestionKey,
  clearAutocompleteSuggestion,
  finishAutocompleteSuggestion,
  getAutocompleteSuggestion,
  shouldTriggerAutocomplete,
  startAutocompleteSuggestion,
} from "@stll/folio-react";

import { apiUrl } from "@/lib/api-url";
import { detached } from "@/lib/detached";
import { fetchWithTimeout } from "@/lib/fetch";
import { readSSEEvents } from "@/lib/sse-events";

import { requestAutocompleteStream } from "./use-autocomplete-stream.logic";

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
  let terminal = false;
  await readSSEEvents(body, (event) => {
    if (event.event === "token") {
      const text = readStringField(event.data, "text");
      if (text === null || text.length === 0) {
        return true;
      }
      return cb.onToken(text);
    }
    if (event.event === "error") {
      terminal = true;
      cb.onError();
      return false;
    }
    if (event.event === "done") {
      terminal = true;
      cb.onDone();
      return false;
    }
    return true;
  });
  // A body that ended without a terminal frame still finishes the suggestion:
  // what streamed is what the model wrote.
  if (!terminal) {
    cb.onDone();
  }
};

/**
 * Wire folio's autocomplete plugin to the backend SSE stream.
 *
 * Subscribes to PM transactions on the given `view`. On a doc
 * change, cancels any in-flight request and (re)schedules a
 * debounced trigger. When the debounce expires, gates via
 * {@link shouldTriggerAutocomplete}, fetches
 * `/v1/ai-autocomplete/stream`, and pumps tokens into the
 * plugin via meta dispatches.
 *
 * Designed for the folio editor where the plugin is already in
 * the editor's plugin array; the host just provides the view
 * handle and the trigger lifecycle.
 */
export const useAutocompleteStream = (
  view: EditorView | null,
  options: UseAutocompleteStreamOptions,
): void => {
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

    const dispatchSafe = (tr: Transaction) => {
      if (!aliveRef.value || view.isDestroyed) {
        return false;
      }
      view.dispatch(tr);
      return true;
    };

    const fireRequest = async () => {
      if (!aliveRef.value) {
        return;
      }
      if (getAutocompleteSuggestion(view.state).status !== "idle") {
        return;
      }
      const check = shouldTriggerAutocomplete(view.state);
      if (!check.ok) {
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
      const requestId = crypto.randomUUID();

      try {
        const response = await requestAutocompleteStream({
          controller,
          dispatchStart: () =>
            dispatchSafe(
              startAutocompleteSuggestion(view.state.tr, anchor, requestId),
            ),
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
        });
        if (response === null) {
          return;
        }
        if (!response.ok || response.body === null) {
          dispatchSafe(clearAutocompleteSuggestion(view.state.tr));
          return;
        }
        await consumeAutocompleteStream(response.body, {
          onToken: (text) =>
            dispatchSafe(
              appendAutocompleteToken(view.state.tr, requestId, text),
            ),
          onError: () => {
            dispatchSafe(clearAutocompleteSuggestion(view.state.tr));
          },
          onDone: () => {
            dispatchSafe(
              finishAutocompleteSuggestion(view.state.tr, requestId),
            );
          },
        });
      } catch {
        if (!controller.signal.aborted) {
          dispatchSafe(clearAutocompleteSuggestion(view.state.tr));
        }
      } finally {
        if (inflight === controller) {
          inflight = null;
        }
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
    // hook, so we install a dispatch wrapper. Every user-driven
    // doc edit (no autocomplete meta) cancels the in-flight
    // request and (re)schedules a new trigger.
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
        if (
          tr.docChanged &&
          tr.getMeta(autocompleteSuggestionKey) === undefined
        ) {
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
  }, [view, enabled, debounceMs, language, minPrefixChars]);
};
