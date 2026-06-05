import { useEffect, useRef } from "react";

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
} from "@stll/folio";

import { apiUrl } from "@/lib/api-url";

export type UseAutocompleteStreamOptions = {
  enabled: boolean;
  debounceMs?: number;
  minPrefixChars?: number;
  language?: string;
};

const DEFAULT_DEBOUNCE_MS = 1500;
const DEFAULT_MIN_PREFIX_CHARS = 8;

type SSEEvent = { event: string; data: string };

const parseSSE = (raw: string): SSEEvent[] => {
  const events: SSEEvent[] = [];
  for (const block of raw.split("\n\n")) {
    if (block.length === 0) {
      continue;
    }
    let event = "message";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) {
        event = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trim());
      }
    }
    events.push({ event, data: dataLines.join("\n") });
  }
  return events;
};

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

const extractPrefix = (
  view: EditorView,
): { prefix: string; anchor: number } => {
  const { state } = view;
  const anchor = state.selection.from;
  const prefix = state.doc.textBetween(0, anchor, "\n", "\n");
  return { prefix, anchor };
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
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) {
      cb.onDone();
      return;
    }
    buffer += decoder.decode(chunk.value, { stream: true });
    const boundary = buffer.lastIndexOf("\n\n");
    if (boundary === -1) {
      continue;
    }
    const ready = buffer.slice(0, boundary + 2);
    buffer = buffer.slice(boundary + 2);
    for (const event of parseSSE(ready)) {
      if (event.event === "token") {
        const text = readStringField(event.data, "text");
        if (text !== null && text.length > 0) {
          const alive = cb.onToken(text);
          if (!alive) {
            return;
          }
        }
      } else if (event.event === "error") {
        cb.onError();
        return;
      } else if (event.event === "done") {
        cb.onDone();
        return;
      }
    }
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
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    const noop = () => {
      /* nothing to clean up */
    };
    if (view === null) {
      return noop;
    }
    if (!optionsRef.current.enabled) {
      return noop;
    }

    const debounceMs = optionsRef.current.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    const minPrefixChars =
      optionsRef.current.minPrefixChars ?? DEFAULT_MIN_PREFIX_CHARS;
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
      if (!aliveRef.value) {
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
      const { prefix, anchor } = extractPrefix(view);
      if (prefix.length < minPrefixChars) {
        return;
      }
      const signature = `${anchor}:${prefix.length}:${prefix.slice(-32)}`;
      if (signature === lastSignature) {
        return;
      }
      lastSignature = signature;

      cancelInflight();
      const controller = new AbortController();
      inflight = controller;
      const requestId = crypto.randomUUID();

      dispatchSafe(
        startAutocompleteSuggestion(view.state.tr, anchor, requestId),
      );

      try {
        const response = await fetch(apiUrl("/ai-autocomplete/stream"), {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            prefix,
            language: optionsRef.current.language,
          }),
          signal: controller.signal,
        });
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
        void fireRequest();
      }, debounceMs);
    };

    // PM doesn't expose a public "subscribe to transactions"
    // hook, so we install a dispatch wrapper. Every user-driven
    // doc edit (no autocomplete meta) cancels the in-flight
    // request and (re)schedules a new trigger.
    const originalDispatch = view.dispatch.bind(view);
    view.setProps({
      dispatchTransaction: (tr) => {
        originalDispatch(tr);
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
    };
  }, [view]);
};
