import { useEffect, useId, useRef, useState } from "react";

import { baseKeymap } from "prosemirror-commands";
import { history, redo, undo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { Schema } from "prosemirror-model";
import type { Command } from "prosemirror-state";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";

import {
  acceptAutocompleteSuggestion,
  acceptAutocompleteWord,
  appendAutocompleteToken,
  autocompleteSuggestionKey,
  autocompleteSuggestionPlugin,
  clearAutocompleteSuggestion,
  finishAutocompleteSuggestion,
  getAutocompleteSuggestion,
  shouldTriggerAutocomplete,
  startAutocompleteSuggestion,
  type AutocompleteTriggerSkipReason,
} from "@stll/folio";

import { apiUrl } from "@/lib/api-url";

const DEBOUNCE_MS = 1500;
const MIN_PREFIX_CHARS = 8;
const MAX_PREFIX_CHARS = 8000;

const playgroundSchema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      group: "block",
      content: "inline*",
      toDOM: () => ["p", 0],
      parseDOM: [{ tag: "p" }],
    },
    text: { group: "inline" },
  },
});

const acceptCommand: Command = (state, dispatch) => {
  const result = acceptAutocompleteSuggestion(state, dispatch);
  return result.accepted;
};

const acceptWordCommand: Command = (state, dispatch) => {
  const result = acceptAutocompleteWord(state, dispatch);
  return result.accepted;
};

const dismissCommand: Command = (state, dispatch) => {
  const current = getAutocompleteSuggestion(state);
  if (current.status === "idle") {
    return false;
  }
  if (dispatch) {
    dispatch(clearAutocompleteSuggestion(state.tr));
  }
  return true;
};

const extractPrefix = (
  view: EditorView,
): { prefix: string; anchor: number } => {
  const { state } = view;
  const anchor = state.selection.from;
  const fullPrefix = state.doc.textBetween(0, anchor, "\n", "\n");
  const prefix = fullPrefix.slice(-MAX_PREFIX_CHARS);
  return { prefix, anchor };
};

type SSEEvent = { event: string; data: string };

const parseSSEBlock = (block: string): SSEEvent | null => {
  if (block.length === 0) {
    return null;
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
  return { event, data: dataLines.join("\n") };
};

const parseSSE = (raw: string): SSEEvent[] => {
  const events: SSEEvent[] = [];
  for (const block of raw.split("\n\n")) {
    const parsed = parseSSEBlock(block);
    if (parsed !== null) {
      events.push(parsed);
    }
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
    if (typeof value === "string") {
      return value;
    }
    return null;
  } catch {
    // Malformed payload: an isolated parse miss is not a
    // user-visible failure in the playground.
    return null;
  }
};

type Status = "idle" | "thinking" | "streaming" | "error";

const startStream = async (
  prefix: string,
  signal: AbortSignal,
): Promise<Response> => {
  const response = await fetch(apiUrl("/ai-autocomplete/stream"), {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prefix, language: "en" }),
    signal,
  });
  return response;
};

type StreamHandlers = {
  onToken: (text: string) => void;
  onStreamError: (message: string) => void;
};

const consumeStream = async (
  body: ReadableStream<Uint8Array>,
  handlers: StreamHandlers,
): Promise<void> => {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let done = false;
  while (!done) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
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
          handlers.onToken(text);
        }
      } else if (event.event === "error") {
        handlers.onStreamError(
          readStringField(event.data, "message") ?? "stream error",
        );
        done = true;
        break;
      } else if (event.event === "done") {
        done = true;
        break;
      }
    }
  }
};

export function AutocompletePlayground() {
  const editorHostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const inflightRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTriggerSignatureRef = useRef<string>("");
  const [status, setStatus] = useState<Status>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [debugInfo, setDebugInfo] = useState<{
    requestId: string;
    prefixTail: string;
    prefixLength: number;
  } | null>(null);
  const [lastSkipReason, setLastSkipReason] =
    useState<AutocompleteTriggerSkipReason | null>(null);
  const editorId = useId();

  useEffect(() => {
    const host = editorHostRef.current;
    if (host === null) {
      return () => {
        /* no-op cleanup */
      };
    }

    const initialDoc = playgroundSchema.node("doc", null, [
      playgroundSchema.node(
        "paragraph",
        null,
        playgroundSchema.text(
          "The lawful bases for processing personal data under GDPR include consent, contract, legal obligation, vital interests, public task, and",
        ),
      ),
    ]);

    const state = EditorState.create({
      schema: playgroundSchema,
      doc: initialDoc,
      plugins: [
        history(),
        keymap({
          "Mod-z": undo,
          "Mod-y": redo,
          "Shift-Mod-z": redo,
          Tab: acceptCommand,
          "Mod-ArrowRight": acceptWordCommand,
          Escape: dismissCommand,
        }),
        keymap(baseKeymap),
        autocompleteSuggestionPlugin({ renderInline: true }),
      ],
    });

    const view = new EditorView(host, { state });
    viewRef.current = view;
    view.focus();

    const cancelInflight = () => {
      if (inflightRef.current !== null) {
        inflightRef.current.abort();
        inflightRef.current = null;
      }
    };

    const triggerRequest = async () => {
      const current = viewRef.current;
      if (current === null) {
        return;
      }
      const existing = getAutocompleteSuggestion(current.state);
      if (existing.status !== "idle") {
        return;
      }
      const check = shouldTriggerAutocomplete(current.state);
      if (!check.ok) {
        setLastSkipReason(check.reason);
        return;
      }
      const { prefix, anchor } = extractPrefix(current);
      if (prefix.length < MIN_PREFIX_CHARS) {
        return;
      }
      const signature = `${anchor}:${prefix.length}:${prefix.slice(-32)}`;
      if (signature === lastTriggerSignatureRef.current) {
        return;
      }
      lastTriggerSignatureRef.current = signature;
      setLastSkipReason(null);

      cancelInflight();
      const controller = new AbortController();
      inflightRef.current = controller;
      const requestId = crypto.randomUUID();

      current.dispatch(
        startAutocompleteSuggestion(current.state.tr, anchor, requestId),
      );
      setStatus("thinking");
      setErrorMessage(null);
      setDebugInfo({
        requestId,
        prefixTail: prefix.slice(-80),
        prefixLength: prefix.length,
      });

      const fail = (message: string) => {
        const live = viewRef.current;
        if (live !== null) {
          live.dispatch(clearAutocompleteSuggestion(live.state.tr));
        }
        setStatus("error");
        setErrorMessage(message);
      };

      try {
        const response = await startStream(prefix, controller.signal);
        if (!response.ok || response.body === null) {
          fail(`HTTP ${response.status}`);
          return;
        }
        let firstToken = true;
        const streamError: { value: string | null } = { value: null };
        await consumeStream(response.body, {
          onToken: (text) => {
            const live = viewRef.current;
            if (live === null) {
              return;
            }
            if (firstToken) {
              firstToken = false;
              setStatus("streaming");
            }
            live.dispatch(
              appendAutocompleteToken(live.state.tr, requestId, text),
            );
          },
          onStreamError: (message) => {
            streamError.value = message;
          },
        });
        if (streamError.value !== null) {
          fail(streamError.value);
          return;
        }
        const live = viewRef.current;
        if (live !== null) {
          live.dispatch(finishAutocompleteSuggestion(live.state.tr, requestId));
        }
        setStatus("idle");
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        fail(error instanceof Error ? error.message : "request failed");
      } finally {
        if (inflightRef.current === controller) {
          inflightRef.current = null;
        }
      }
    };

    const scheduleTrigger = () => {
      if (debounceRef.current !== null) {
        clearTimeout(debounceRef.current);
      }
      debounceRef.current = setTimeout(() => {
        void triggerRequest();
      }, DEBOUNCE_MS);
    };

    const originalDispatch = view.props.dispatchTransaction?.bind(view);
    view.setProps({
      dispatchTransaction: (tr) => {
        if (originalDispatch === undefined) {
          view.updateState(view.state.apply(tr));
        } else {
          originalDispatch(tr);
        }
        if (
          tr.docChanged &&
          tr.getMeta(autocompleteSuggestionKey) === undefined
        ) {
          cancelInflight();
          setStatus("idle");
          setErrorMessage(null);
          scheduleTrigger();
        }
      },
    });

    return () => {
      cancelInflight();
      if (debounceRef.current !== null) {
        clearTimeout(debounceRef.current);
      }
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  let statusLabel = "";
  if (status === "thinking") {
    statusLabel = "thinking…";
  } else if (status === "streaming") {
    statusLabel = "streaming…";
  } else if (status === "error" && errorMessage !== null) {
    statusLabel = `error: ${errorMessage}`;
  }

  return (
    <div className="folio-ai-host flex h-full w-full flex-col gap-4 p-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">
          stella autocomplete — dev playground
        </h1>
        <p className="text-muted-foreground text-sm">
          Bare ProseMirror, no paged renderer. Type and pause; Tab to accept
          all, ⌘→ to accept one word, Esc to dismiss. {statusLabel}
        </p>
      </header>
      <div
        id={editorId}
        ref={editorHostRef}
        className="border-border bg-background min-h-[320px] flex-1 rounded-md border p-6 font-serif text-base leading-relaxed [&_p]:m-0 [&_p+p]:mt-4"
        spellCheck="false"
      />
      <aside className="border-border bg-muted/30 text-muted-foreground rounded-md border p-3 font-mono text-xs">
        <div className="text-foreground mb-1 font-sans text-[11px] tracking-wide uppercase">
          last request sent to model
        </div>
        {debugInfo === null ? (
          <div className="opacity-60">— none yet —</div>
        ) : (
          <div className="flex flex-col gap-1">
            <div>
              <span className="opacity-60">requestId: </span>
              {debugInfo.requestId.slice(0, 8)}…
            </div>
            <div>
              <span className="opacity-60">prefix length: </span>
              {debugInfo.prefixLength} chars
            </div>
            <div>
              <span className="opacity-60">prefix tail (last 80): </span>
              <span className="text-foreground">{debugInfo.prefixTail}</span>
            </div>
          </div>
        )}
        {lastSkipReason !== null && (
          <div className="text-foreground mt-2 border-t pt-2 opacity-80">
            <span className="opacity-60">last trigger skipped: </span>
            {lastSkipReason}
          </div>
        )}
      </aside>
    </div>
  );
}
