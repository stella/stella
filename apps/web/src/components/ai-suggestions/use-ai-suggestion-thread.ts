import { useCallback, useEffect, useMemo, useState } from "react";

import type { EditorView } from "prosemirror-view";

import { resolveSuggestionAnchor } from "@stll/folio";
import type { AICitation, AISuggestion } from "@stll/folio";

import type {
  AssistantThreadMessage,
  ThreadMessage,
} from "@/components/ai-suggestions/types";

type UseAISuggestionThreadArgs = {
  editorView: EditorView | null;
};

type ApplyResult = {
  applied: string[];
  stale: string[];
};

/**
 * Owns the file-chat host's message thread state.
 *
 * Holds the messages array, the queued-accept ids deferred until the
 * editor unlocks, and the message/suggestion mutators used by the
 * accept/reject pipeline. Recomputes pending↔stale suggestion status
 * whenever the document changes so the apply UI cannot fire against a
 * range the user has since edited away.
 */
export const useAISuggestionThread = ({
  editorView,
}: UseAISuggestionThreadArgs) => {
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [pendingAccepts, setPendingAccepts] = useState<string[]>([]);

  // ---- derived state -------------------------------------------------------

  const allSuggestions = useMemo<AISuggestion[]>(() => {
    const out: AISuggestion[] = [];
    for (const m of messages) {
      if (m.role === "assistant") {
        out.push(...m.suggestions);
      }
    }
    return out;
  }, [messages]);

  const allCitations = useMemo<AICitation[]>(() => {
    const out: AICitation[] = [];
    for (const m of messages) {
      if (m.role === "assistant") {
        out.push(...m.citations);
      }
    }
    return out;
  }, [messages]);

  // Recompute stale status whenever the document changes.
  useEffect(() => {
    if (!editorView || allSuggestions.length === 0) {
      return;
    }
    const doc = editorView.state.doc;
    setMessages((prev) => {
      const messagesState = { changed: false };
      const next = prev.map<ThreadMessage>((m) => {
        if (m.role !== "assistant" || m.suggestions.length === 0) {
          return m;
        }
        const suggestionsState = { changed: false };
        const updated = m.suggestions.map((s): AISuggestion => {
          if (s.status !== "pending" && s.status !== "stale") {
            return s;
          }
          const anchor = resolveSuggestionAnchor(doc, s);
          const nextStatus: AISuggestion["status"] =
            anchor === null ? "stale" : "pending";
          if (nextStatus === s.status) {
            return s;
          }
          suggestionsState.changed = true;
          return { ...s, status: nextStatus };
        });
        if (!suggestionsState.changed) {
          return m;
        }
        messagesState.changed = true;
        return { ...m, suggestions: updated };
      });
      return messagesState.changed ? next : prev;
    });
  }, [editorView, allSuggestions, editorView?.state.doc]);

  // ---- mutators ------------------------------------------------------------

  const updateAssistantMessage = useCallback(
    (
      id: string,
      mutate: (m: AssistantThreadMessage) => AssistantThreadMessage,
    ) => {
      setMessages((prev) =>
        prev.map((m) =>
          m.role === "assistant" && m.id === id ? mutate(m) : m,
        ),
      );
    },
    [],
  );

  const updateSuggestion = useCallback(
    (
      messageId: string,
      suggestionId: string,
      mutate: (s: AISuggestion) => AISuggestion,
    ) => {
      updateAssistantMessage(messageId, (m) => ({
        ...m,
        suggestions: m.suggestions.map((s) =>
          s.id === suggestionId ? mutate(s) : s,
        ),
      }));
    },
    [updateAssistantMessage],
  );

  const applyResultToMessages = useCallback((result: ApplyResult) => {
    setMessages((prev) =>
      prev.map<ThreadMessage>((m) => {
        if (m.role !== "assistant" || m.suggestions.length === 0) {
          return m;
        }
        const suggestionState = { changed: false };
        const next = m.suggestions.map((s): AISuggestion => {
          if (result.applied.includes(s.id)) {
            suggestionState.changed = true;
            return { ...s, status: "accepted" };
          }
          if (result.stale.includes(s.id)) {
            suggestionState.changed = true;
            return { ...s, status: "stale" };
          }
          return s;
        });
        return suggestionState.changed ? { ...m, suggestions: next } : m;
      }),
    );
  }, []);

  return {
    messages,
    setMessages,
    allSuggestions,
    allCitations,
    pendingAccepts,
    setPendingAccepts,
    updateAssistantMessage,
    updateSuggestion,
    applyResultToMessages,
  };
};
