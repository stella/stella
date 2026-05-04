/**
 * File-anchored AI chat host.
 *
 * Renders a glass prompt bar at the bottom of the file viewer plus,
 * when expanded, a thread panel above it. The thread is the primary
 * UI — same interaction model as Stella's regular chat, but bound to
 * a single file in view. Each user prompt yields one assistant
 * message that may carry markdown text, suggested edits, or both.
 *
 * The host owns: thread state, prompt bar, slash menu, paste chip,
 * pending-accept queue, and decoration push for the editor view (when
 * one is supplied — DOCX). For PDFs `editorView` is null; the host
 * still renders the bar + thread, but accept buttons are hidden.
 */

import "@/components/chat-editor.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComponentProps, ReactNode } from "react";

import {
  applySuggestions,
  resolveSuggestionAnchor,
  setActiveCitationMeta,
  setAICitationsMeta,
  setAISuggestionsMeta,
  setFocusedSuggestionMeta,
} from "@stll/folio";
import type {
  AIChatMode,
  AICitation,
  AICitationRange,
  AIGenerateInput,
  AISuggestion,
  AISuggestionApplyMode,
  AISuggestionSeverity,
} from "@stll/folio";
import { Button } from "@stll/ui/components/button";
import {
  Tooltip,
  TooltipPopup,
  TooltipProvider,
  TooltipTrigger,
} from "@stll/ui/components/tooltip";
import { cn } from "@stll/ui/lib/utils";
import { EditorContent } from "@tiptap/react";
import {
  ArrowUpIcon,
  CheckIcon,
  ChevronDownIcon,
  LoaderCircleIcon,
  SquareIcon,
  SquarePenIcon,
} from "lucide-react";
import type { EditorView } from "prosemirror-view";
import { useTranslations } from "use-intl";

import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import type { ChatEditorController } from "@/components/chat-editor-provider";

import type {
  AssistantThreadMessage,
  FileAIChatConfig,
  FileAIChatStatus,
  ThreadMessage,
  UserThreadMessage,
} from "./types";

/**
 * localStorage key for the per-user "apply with tracked changes?"
 * preference. Asked once on the first accept, then remembered.
 */
const APPLY_MODE_STORAGE_KEY = "stella:ai-suggestions:apply-mode";

function readStoredApplyMode(): AISuggestionApplyMode | null {
  try {
    const raw = localStorage.getItem(APPLY_MODE_STORAGE_KEY);
    if (raw === "direct" || raw === "tracked-changes") {
      return raw;
    }
  } catch {
    // localStorage may be disabled (private mode, third-party cookie
    // restrictions); fall through to "no preference".
  }
  return null;
}

/**
 * Flatten the TipTap editor's HTML draft into the plain-text
 * "prompt" the host's generators expect. Entity-mention nodes —
 * which render as `<entity-mention data-label="…">` — collapse to
 * `@<label>` so pattern matchers still see the mentioned thing as
 * a token. Other tags lose their structure but keep textContent.
 */
function htmlToPromptText(html: string): string {
  if (typeof document === "undefined" || html.length === 0) {
    return html;
  }
  const container = document.createElement("div");
  container.innerHTML = html;
  for (const mention of container.querySelectorAll("entity-mention")) {
    const label =
      mention instanceof HTMLElement ? (mention.dataset["label"] ?? "") : "";
    mention.replaceWith(document.createTextNode(`@${label}`));
  }
  return (container.textContent ?? "").trim();
}

function writeStoredApplyMode(mode: AISuggestionApplyMode): void {
  try {
    localStorage.setItem(APPLY_MODE_STORAGE_KEY, mode);
  } catch {
    // best-effort; lack of persistence just means we'll re-ask next session
  }
}

const SEVERITY_LABEL: Record<AISuggestionSeverity, string> = {
  substantive: "Substantive",
  style: "Style",
  typo: "Typo",
};

const SEVERITY_DOT_CLASS: Record<AISuggestionSeverity, string> = {
  substantive: "bg-destructive",
  style: "bg-foreground/55",
  typo: "bg-muted-foreground",
};

/**
 * Visual layout mode.
 *
 * - `floating` (default): bar + thread are absolutely positioned over
 *   a file viewer. Thread is glass and toggles open/closed. Used by
 *   `FileViewerWithAI`.
 * - `standalone`: bar + thread fill their parent container. Thread is
 *   always visible (flex-1, scrollable), bar sits at the bottom in
 *   flow. Used by the sidepeek Chat tab where there's no doc behind.
 */
export type FileAIChatLayout = "floating" | "standalone";

type FileAIChatHostProps = {
  config: FileAIChatConfig;
  /**
   * Live ProseMirror view for the editable file (DOCX). When null,
   * the host runs in read-only/no-apply mode (PDF or any non-editable
   * viewer).
   */
  editorView: EditorView | null;
  /** Plain-text snapshot of the file used when no editor view is available. */
  documentText?: string;
  /** Whether the underlying viewer is locked for editing (e.g., DOCX preview). */
  readOnly: boolean;
  /** Container the bar anchors against (used to detect compact mode). */
  containerEl: HTMLElement | null;
  /** Author label fallback when the host config doesn't set one. */
  authorFallback: string;
  /**
   * Fired when the user clicks a citation chip. The wrapper plugs
   * this into the PDF justification store so the existing PageCitation
   * overlay can render bbox highlights for non-PM viewers. Folio
   * decorations are pushed directly via PM meta inside the host.
   */
  onCitationActivate?: (citation: AICitation | null) => void;
  /** See `FileAIChatLayout`. Defaults to `floating`. */
  layout?: FileAIChatLayout;
  /**
   * TipTap composer controller from `useChatEditor`. The bar renders
   * the rich editor (with `@`-mention chips, drafts, attachments) on
   * top of this controller; the host intercepts `controller.submit`
   * and forwards the resulting HTML to `config.onGenerate` as
   * `prompt`. Every host instance has one — file-overlay chats and
   * standalone chat tabs alike — so the composer experience stays
   * identical across surfaces.
   */
  editorController: ChatEditorController;
  emptyPlaceholder?: ReactNode | undefined;
};

export function FileAIChatHost(props: FileAIChatHostProps) {
  const {
    config,
    editorView,
    documentText: documentTextProp,
    readOnly,
    authorFallback,
    onCitationActivate,
    layout = "floating",
    editorController,
  } = props;
  const author = config.applyAuthor ?? authorFallback;

  /**
   * The viewer is editable when a PM view is mounted. PDFs are never
   * editable; DOCX always exposes a view (preview + edit).
   */
  const canEdit = editorView !== null;

  /**
   * Mode is fully derived from context: Ask for PDFs and locked
   * DOCX previews; Edit only when the user is actively editing an
   * unlocked DOCX. There's no manual toggle — the document state is
   * the source of truth, which keeps the bar uncluttered.
   */
  const mode: AIChatMode = canEdit && !readOnly ? "edit" : "ask";
  /**
   * Persisted apply-mode preference. Null when the user hasn't yet
   * answered the one-time "apply with tracked changes?" prompt; we
   * gate the first accept on this answer and remember it for next
   * time via localStorage.
   */
  const [applyModeStored, setApplyModeStored] =
    useState<AISuggestionApplyMode | null>(() => readStoredApplyMode());
  /**
   * The accept the user most recently triggered while the apply-mode
   * preference was unset. Held until they answer the prompt; then
   * applied with the chosen mode.
   */
  const [pendingFirstAccept, setPendingFirstAccept] = useState<
    | { kind: "one"; suggestionId: string }
    | { kind: "group"; messageId: string }
    | null
  >(null);
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [panelOpen, setPanelOpen] = useState(false);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [activeCitationId, setActiveCitationId] = useState<string | null>(null);
  /**
   * User-set panel height in px. Null means "use the default
   * max-height" (~58% of viewport). Set on drag of the resize
   * handle at the top of the panel.
   */
  const [panelHeight, setPanelHeight] = useState<number | null>(null);
  const [pendingAccepts, setPendingAccepts] = useState<string[]>([]);

  /**
   * Effective apply mode. When the stored preference is null we
   * still need a value to fall back to in code paths that read it
   * (e.g., the auto-flush effect after unlock); use the host's
   * default. The user-facing "ask once" prompt only blocks the very
   * first accept attempt.
   */
  const applyMode: AISuggestionApplyMode =
    applyModeStored ?? config.defaultApplyMode ?? "direct";

  const persistApplyMode = useCallback((next: AISuggestionApplyMode) => {
    setApplyModeStored(next);
    writeStoredApplyMode(next);
  }, []);

  const generationToken = useRef(0);

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

  /**
   * Folio range citations flattened for the decoration plugin.
   * PDF-bbox citations are forwarded through `onCitationActivate`
   * to the wrapper's PDF overlay.
   */
  const folioCitationRanges = useMemo<AICitationRange[]>(() => {
    const out: AICitationRange[] = [];
    for (const c of allCitations) {
      if (c.source.kind === "folio-range") {
        out.push({ id: c.id, from: c.source.from, to: c.source.to });
      }
    }
    return out;
  }, [allCitations]);

  const pendingCount = useMemo(
    () => allSuggestions.filter((s) => s.status === "pending").length,
    [allSuggestions],
  );

  const generating = messages.some(
    (m) => m.role === "assistant" && m.status === "loading",
  );

  const status: FileAIChatStatus = generating
    ? "generating"
    : pendingCount > 0
      ? "review-ready"
      : "idle";

  // ---- decoration push (DOCX only) ----------------------------------------

  // The decoration plugin has at most one writer at a time. The
  // active-docx-edit flow (apply-active-docx-edits tool → review
  // store) pushes its own suggestion list from `DocxBrowserEditor`;
  // dispatching an empty list here would race with that and clear
  // its decorations. Skip when we have nothing to add — the review
  // store path handles the cleared/transitioning case via its
  // own effect.
  useEffect(() => {
    if (!editorView || allSuggestions.length === 0) {
      return;
    }
    const meta = setAISuggestionsMeta(allSuggestions);
    editorView.dispatch(editorView.state.tr.setMeta(meta.key, meta.payload));
  }, [editorView, allSuggestions]);

  useEffect(() => {
    if (!editorView) {
      return;
    }
    const meta = setFocusedSuggestionMeta(focusedId);
    editorView.dispatch(editorView.state.tr.setMeta(meta.key, meta.payload));
  }, [editorView, focusedId]);

  // Push folio citation ranges to the decoration plugin.
  useEffect(() => {
    if (!editorView) {
      return;
    }
    const meta = setAICitationsMeta(folioCitationRanges);
    editorView.dispatch(editorView.state.tr.setMeta(meta.key, meta.payload));
  }, [editorView, folioCitationRanges]);

  useEffect(() => {
    if (!editorView) {
      return;
    }
    const meta = setActiveCitationMeta(activeCitationId);
    editorView.dispatch(editorView.state.tr.setMeta(meta.key, meta.payload));
  }, [editorView, activeCitationId]);

  // Recompute stale status whenever the document changes.
  useEffect(() => {
    if (!editorView || allSuggestions.length === 0) {
      return;
    }
    const doc = editorView.state.doc;
    setMessages((prev) => {
      let changed = false;
      const next = prev.map<ThreadMessage>((m) => {
        if (m.role !== "assistant" || m.suggestions.length === 0) {
          return m;
        }
        let suggestionsChanged = false;
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
          suggestionsChanged = true;
          return { ...s, status: nextStatus };
        });
        if (!suggestionsChanged) {
          return m;
        }
        changed = true;
        return { ...m, suggestions: updated };
      });
      return changed ? next : prev;
    });
  }, [editorView, allSuggestions, editorView?.state.doc]);

  // ---- helpers -------------------------------------------------------------

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

  // ---- generate ------------------------------------------------------------

  const handleGenerate = useCallback(
    async (input: {
      prompt: string;
      presetId?: string;
      pastedText?: string;
    }) => {
      if (generating) {
        return;
      }

      // The bar emits prompt as HTML from the TipTap editor — entity
      // mentions live as `<entity-mention data-label="…">` nodes.
      // Flatten to plain text (with mentions inlined as `@Label`) so
      // pattern-matching generators don't have to parse HTML.
      const promptText = htmlToPromptText(input.prompt);

      const userMessage: UserThreadMessage = {
        id: `u-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        role: "user",
        prompt: promptText,
        mode,
        createdAt: Date.now(),
        ...(input.presetId === undefined ? {} : { presetId: input.presetId }),
        ...(input.pastedText === undefined
          ? {}
          : { pastedText: input.pastedText }),
      };
      const assistantId = `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const assistantPlaceholder: AssistantThreadMessage = {
        id: assistantId,
        role: "assistant",
        text: "",
        suggestions: [],
        citations: [],
        mode,
        status: "loading",
        createdAt: Date.now(),
      };

      setMessages((prev) => [...prev, userMessage, assistantPlaceholder]);
      setPanelOpen(true);

      const token = ++generationToken.current;

      const fullPrompt = input.pastedText
        ? promptText.length === 0
          ? input.pastedText
          : `${promptText}\n\n${input.pastedText}`
        : promptText;

      const docText = editorView
        ? editorView.state.doc.textBetween(
            0,
            editorView.state.doc.content.size,
            "\n",
            "\n",
          )
        : (documentTextProp ?? "");
      const selection =
        editorView !== null &&
        editorView.state.selection.from !== editorView.state.selection.to
          ? editorView.state.selection
          : null;
      const selectionText =
        selection !== null && editorView !== null
          ? editorView.state.doc.textBetween(
              selection.from,
              selection.to,
              "\n",
              "\n",
            )
          : "";
      const cursorPosition =
        editorView !== null
          ? {
              from: editorView.state.selection.from,
              to: editorView.state.selection.to,
            }
          : null;
      const visible = editorView ? computeVisibleRange(editorView) : null;
      const visibleText =
        visible !== null && editorView !== null
          ? editorView.state.doc.textBetween(
              visible.from,
              visible.to,
              "\n",
              "\n",
            )
          : "";
      const generateInput: AIGenerateInput = {
        prompt: fullPrompt,
        mode,
        selectionText,
        selectionRange:
          selection !== null
            ? { from: selection.from, to: selection.to }
            : null,
        cursorPosition,
        documentText: docText,
        visibleText,
        visibleRange: visible,
        ...(input.presetId === undefined ? {} : { presetId: input.presetId }),
      };

      try {
        const response = await config.onGenerate(generateInput);
        if (generationToken.current !== token) {
          return;
        }
        const rawSuggestions =
          mode === "ask" ? [] : (response.suggestions ?? []);
        const anchored: AISuggestion[] = [];
        for (const s of rawSuggestions) {
          if (!editorView) {
            anchored.push(s);
            continue;
          }
          const anchor = resolveSuggestionAnchor(editorView.state.doc, s);
          anchored.push(
            anchor === null
              ? { ...s, status: "stale" }
              : { ...s, range: anchor },
          );
        }
        updateAssistantMessage(assistantId, (m) => ({
          ...m,
          status: "complete",
          text: response.text ?? "",
          suggestions: anchored,
          citations: response.citations ?? [],
        }));
      } catch (error) {
        if (generationToken.current !== token) {
          return;
        }
        updateAssistantMessage(assistantId, (m) => ({
          ...m,
          status: "error",
          error: error instanceof Error ? error.message : "Generation failed",
        }));
      }
    },
    [
      generating,
      editorView,
      documentTextProp,
      config,
      updateAssistantMessage,
      mode,
    ],
  );

  // ---- accept / reject -----------------------------------------------------

  const findSuggestion = useCallback(
    (suggestionId: string) =>
      allSuggestions.find((s) => s.id === suggestionId) ?? null,
    [allSuggestions],
  );

  const findOwningMessageId = useCallback(
    (suggestionId: string): string | null => {
      for (const m of messages) {
        if (m.role !== "assistant") {
          continue;
        }
        if (m.suggestions.some((s) => s.id === suggestionId)) {
          return m.id;
        }
      }
      return null;
    },
    [messages],
  );

  const applyResultToMessages = useCallback(
    (result: { applied: string[]; stale: string[] }) => {
      setMessages((prev) =>
        prev.map<ThreadMessage>((m) => {
          if (m.role !== "assistant" || m.suggestions.length === 0) {
            return m;
          }
          let changed = false;
          const next = m.suggestions.map((s): AISuggestion => {
            if (result.applied.includes(s.id)) {
              changed = true;
              return { ...s, status: "accepted" };
            }
            if (result.stale.includes(s.id)) {
              changed = true;
              return { ...s, status: "stale" };
            }
            return s;
          });
          return changed ? { ...m, suggestions: next } : m;
        }),
      );
    },
    [],
  );

  // Apply a single suggestion at the given mode. Split out from
  // handleAcceptOne so resolveFirstAccept can re-run the deferred
  // accept against the *freshly chosen* mode without going back
  // through the first-accept gate that captured `applyModeStored ===
  // null` in the original closure.
  const acceptOneAtMode = useCallback(
    (suggestionId: string, applyAt: AISuggestionApplyMode) => {
      const target = findSuggestion(suggestionId);
      if (!target || target.status !== "pending") {
        return;
      }
      if (readOnly) {
        if (!config.onUnlockRequest) {
          return;
        }
        setPendingAccepts((prev) =>
          prev.includes(suggestionId) ? prev : [...prev, suggestionId],
        );
        config.onUnlockRequest();
        return;
      }
      if (!editorView) {
        return;
      }
      const result = applySuggestions({
        view: editorView,
        suggestions: [target],
        mode: applyAt,
        author,
      });
      applyResultToMessages(result);
    },
    [
      findSuggestion,
      readOnly,
      config,
      editorView,
      author,
      applyResultToMessages,
    ],
  );

  const handleAcceptOne = useCallback(
    (suggestionId: string) => {
      // First-time accept: ask whether to apply with tracked changes,
      // remember the answer, and defer this accept until they pick.
      if (applyModeStored === null) {
        const target = findSuggestion(suggestionId);
        if (!target || target.status !== "pending") {
          return;
        }
        setPendingFirstAccept({ kind: "one", suggestionId });
        return;
      }
      acceptOneAtMode(suggestionId, applyMode);
    },
    [applyModeStored, findSuggestion, acceptOneAtMode, applyMode],
  );

  const handleRejectOne = useCallback(
    (suggestionId: string) => {
      const messageId = findOwningMessageId(suggestionId);
      if (!messageId) {
        return;
      }
      updateSuggestion(messageId, suggestionId, (s) => ({
        ...s,
        status: "rejected",
      }));
    },
    [findOwningMessageId, updateSuggestion],
  );

  // Apply every pending suggestion in a message at the given mode.
  // Mirror of acceptOneAtMode, with the same rationale.
  const acceptGroupAtMode = useCallback(
    (messageId: string, applyAt: AISuggestionApplyMode) => {
      const message = messages.find(
        (m): m is AssistantThreadMessage =>
          m.role === "assistant" && m.id === messageId,
      );
      if (!message) {
        return;
      }
      const targets = message.suggestions.filter((s) => s.status === "pending");
      if (targets.length === 0) {
        return;
      }
      if (readOnly) {
        if (!config.onUnlockRequest) {
          return;
        }
        const ids = targets.map((s) => s.id);
        setPendingAccepts((prev) => {
          const merged = new Set(prev);
          for (const id of ids) {
            merged.add(id);
          }
          return [...merged];
        });
        config.onUnlockRequest();
        return;
      }
      if (!editorView) {
        return;
      }
      const result = applySuggestions({
        view: editorView,
        suggestions: targets,
        mode: applyAt,
        author,
      });
      applyResultToMessages(result);
    },
    [messages, readOnly, config, editorView, author, applyResultToMessages],
  );

  const handleAcceptGroup = useCallback(
    (messageId: string) => {
      if (applyModeStored === null) {
        const message = messages.find(
          (m): m is AssistantThreadMessage =>
            m.role === "assistant" && m.id === messageId,
        );
        if (!message) {
          return;
        }
        const hasPending = message.suggestions.some(
          (s) => s.status === "pending",
        );
        if (!hasPending) {
          return;
        }
        setPendingFirstAccept({ kind: "group", messageId });
        return;
      }
      acceptGroupAtMode(messageId, applyMode);
    },
    [applyModeStored, messages, acceptGroupAtMode, applyMode],
  );

  const handleRejectGroup = useCallback(
    (messageId: string) => {
      updateAssistantMessage(messageId, (m) => ({
        ...m,
        suggestions: m.suggestions.map((s) =>
          s.status === "pending" ? { ...s, status: "rejected" } : s,
        ),
      }));
    },
    [updateAssistantMessage],
  );

  /**
   * Called from the apply-mode prompt: persist the user's choice and
   * re-run whichever accept they had just attempted, against the
   * freshly chosen mode (we go around the apply-mode gate in
   * `handleAcceptOne`/`handleAcceptGroup` because that gate would
   * still see `applyModeStored === null` until React re-renders).
   */
  const resolveFirstAccept = useCallback(
    (chosen: AISuggestionApplyMode) => {
      const queued = pendingFirstAccept;
      persistApplyMode(chosen);
      setPendingFirstAccept(null);
      if (!queued) {
        return;
      }
      if (queued.kind === "one") {
        acceptOneAtMode(queued.suggestionId, chosen);
      } else {
        acceptGroupAtMode(queued.messageId, chosen);
      }
    },
    [pendingFirstAccept, persistApplyMode, acceptOneAtMode, acceptGroupAtMode],
  );

  // ---- pending-accept flush on unlock --------------------------------------

  useEffect(() => {
    if (readOnly || !editorView || pendingAccepts.length === 0) {
      return;
    }
    const queued = new Set(pendingAccepts);
    setPendingAccepts([]);
    const targets = allSuggestions.filter(
      (s) => queued.has(s.id) && s.status === "pending",
    );
    if (targets.length === 0) {
      return;
    }
    const result = applySuggestions({
      view: editorView,
      suggestions: targets,
      mode: applyMode,
      author,
    });
    applyResultToMessages(result);
  }, [
    readOnly,
    editorView,
    pendingAccepts,
    allSuggestions,
    applyMode,
    author,
    applyResultToMessages,
  ]);

  // ---- focus + scroll-to ---------------------------------------------------

  const handleFocusSuggestion = useCallback(
    (suggestionId: string) => {
      setFocusedId(suggestionId);
      const target = findSuggestion(suggestionId);
      if (!editorView || !target) {
        return;
      }
      const anchor = resolveSuggestionAnchor(editorView.state.doc, target);
      if (!anchor) {
        return;
      }
      const scrollContainer = editorView.dom.closest("[data-folio-scroll]");
      if (scrollContainer === null) {
        return;
      }
      const coords = editorView.coordsAtPos(anchor.from);
      const rect = scrollContainer.getBoundingClientRect();
      const targetTop = coords.top - rect.top + scrollContainer.scrollTop;
      scrollContainer.scrollTo({
        top: targetTop - rect.height / 3,
        behavior: "smooth",
      });
    },
    [editorView, findSuggestion],
  );

  // ---- citation activate ---------------------------------------------------

  const handleActivateCitation = useCallback(
    (citation: AICitation) => {
      setActiveCitationId(citation.id);
      // PDF: notify the wrapper to drive its own bbox overlay.
      onCitationActivate?.(citation);
      // Folio: scroll the editor to the cited range.
      if (citation.source.kind === "folio-range" && editorView) {
        const scrollContainer = editorView.dom.closest("[data-folio-scroll]");
        if (scrollContainer === null) {
          return;
        }
        const coords = editorView.coordsAtPos(citation.source.from);
        const rect = scrollContainer.getBoundingClientRect();
        const targetTop = coords.top - rect.top + scrollContainer.scrollTop;
        scrollContainer.scrollTo({
          top: targetTop - rect.height / 3,
          behavior: "smooth",
        });
      }
    },
    [editorView, onCitationActivate],
  );

  // ---- keybindings ---------------------------------------------------------

  // Escape closes the floating thread panel. In standalone there's
  // no panel to close (the thread is always visible alongside the
  // bar), so the binding is skipped — no need to install a global
  // keydown listener that would always be a no-op.
  useEffect(() => {
    if (layout !== "floating") {
      return undefined;
    }
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && panelOpen) {
        setPanelOpen(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", handler);
    };
  }, [layout, panelOpen]);

  // (Mode is derived from canEdit + readOnly — no auto-sync needed.)

  // ---- render --------------------------------------------------------------

  const hasMessages = messages.length > 0;
  const showAcceptUI = editorView !== null || readOnly; // hide for true PDF (no view, not readOnly)

  // In standalone the thread is always visible (it fills the
  // container alongside the bar), so the floating-only "open/close"
  // toggle is irrelevant.
  const threadVisible = layout === "standalone" || (panelOpen && hasMessages);

  const threadPanel = threadVisible ? (
    <ThreadPanel
      layout={layout}
      messages={messages}
      focusedId={focusedId}
      activeCitationId={activeCitationId}
      showAcceptUI={showAcceptUI && mode === "edit"}
      pendingFirstAccept={pendingFirstAccept !== null}
      onResolveFirstAccept={resolveFirstAccept}
      height={panelHeight}
      onResize={setPanelHeight}
      onAcceptOne={handleAcceptOne}
      onRejectOne={handleRejectOne}
      onAcceptGroup={handleAcceptGroup}
      onRejectGroup={handleRejectGroup}
      onFocusSuggestion={handleFocusSuggestion}
      onActivateCitation={handleActivateCitation}
    />
  ) : null;

  const promptBar = (
    <PromptBar
      layout={layout}
      status={status}
      pendingCount={pendingCount}
      panelOpen={panelOpen}
      showThreadToggle={layout === "floating" && hasMessages}
      onSubmit={(input) => {
        void handleGenerate(input);
      }}
      onTogglePanel={() => setPanelOpen((v) => !v)}
      editorController={editorController}
    />
  );

  if (layout === "standalone") {
    return (
      <TooltipProvider delay={300}>
        <div className="flex h-full min-h-0 flex-col">
          {threadPanel}
          {promptBar}
        </div>
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider delay={300}>
      {threadPanel}
      {promptBar}
    </TooltipProvider>
  );
}

// ===========================================================================
// View helpers
// ===========================================================================

/**
 * Best-effort PM range of what the user is currently looking at,
 * scoped to the editor's scroll container. The model uses this to
 * bias answers toward the visible region — "what does this section
 * say?" implicitly means "this section in front of me".
 *
 * Falls back to null when the scroll container or coordinate lookup
 * isn't reachable (initial render, detached view).
 */
function computeVisibleRange(
  view: EditorView,
): { from: number; to: number } | null {
  const scrollContainer = view.dom.closest("[data-folio-scroll]");
  if (scrollContainer === null) {
    return null;
  }
  const rect = scrollContainer.getBoundingClientRect();
  // Probe a small inset from each edge so we don't catch ghost gaps
  // between pages or padding.
  const PROBE_INSET = 12;
  const top = view.posAtCoords({
    left: rect.left + PROBE_INSET,
    top: rect.top + PROBE_INSET,
  });
  const bottom = view.posAtCoords({
    left: rect.left + PROBE_INSET,
    top: rect.bottom - PROBE_INSET,
  });
  if (!top || !bottom) {
    return null;
  }
  const from = Math.min(top.pos, bottom.pos);
  const to = Math.max(top.pos, bottom.pos);
  if (to <= from) {
    return null;
  }
  return { from, to };
}

// ===========================================================================
// Prompt bar
// ===========================================================================

type PromptBarProps = {
  layout: FileAIChatLayout;
  status: FileAIChatStatus;
  onSubmit: (input: { prompt: string }) => void;
  onNewThread?: (() => void) | undefined;
  newThreadLabel?: string | undefined;
  /**
   * Optional cancel callback. When provided AND `status` is
   * `"generating"`, the send button morphs into a stop button
   * that calls this on click. Lets a single button toggle
   * between the two intents instead of stacking a second
   * floating control on top of the bar.
   */
  onStop?: () => void;

  // ---- floating-only -----------------------------------------------------
  // These three props drive UI that only exists in floating mode
  // (thread open/close chevron, pending-suggestion badge). In
  // standalone we still pass safe defaults — a discriminated union
  // would be cleaner but doubles the type surface.
  pendingCount: number;
  panelOpen: boolean;
  showThreadToggle: boolean;
  onTogglePanel: () => void;

  /**
   * Rich-editor controller from `useChatEditor`. The bar renders
   * the TipTap composer (chips, mentions, drafts) on top of this
   * controller. The Placeholder, Mention, and (future) slash-command
   * extensions live inside the controller's editor — this component
   * is just the chrome around them.
   */
  editorController: ChatEditorController;
  emptyPlaceholder?: ReactNode | undefined;
  /**
   * Monotonic counter from the review store. When it increments
   * the bar plays a one-shot glow — fired by the inspector when
   * the user clicks the AI-suggestions chip, so the producing
   * surface (this bar) lights up briefly to confirm the panel is
   * fed from this chat.
   */
  attentionPulseSeq?: number | undefined;
  /**
   * Whether the bar is allowed to send. False when we know the
   * downstream tool can't be honoured — currently set by the
   * file-chat overlay while the Folio PM view hasn't initialised
   * (no snapshot to attach to apply-active-docx-edits). The send
   * button is disabled and a "Loading editor…" hint replaces the
   * empty-state placeholder so the user doesn't fire a message
   * into a dead context.
   */
  sendDisabledReason?: "editor-loading" | undefined;
};

/**
 * Styled placeholder label rendered in the prompt bar when the editor
 * is empty. Shared between the live `PromptBar` (via `emptyPlaceholder`)
 * and the loading `PromptBarPlaceholder` shell so both surfaces are
 * pixel-identical and can never drift.
 */
export function PromptBarPlaceholderContent({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <span className="text-muted-foreground/60 truncate text-[13px] leading-5">
      {children}
    </span>
  );
}

type PromptBarShellProps = {
  layout: FileAIChatLayout;
  children: ReactNode;
} & Omit<ComponentProps<"div">, "children">;

/**
 * Shared outer shell for the glass prompt bar. Both the live
 * `PromptBar` and the loading `PromptBarPlaceholder` (in the
 * inspector) render through this so they can never drift apart.
 */
export function PromptBarShell({
  layout,
  children,
  className,
  ...rest
}: PromptBarShellProps) {
  return (
    <div
      {...rest}
      className={cn(
        "group/bar bg-background/75 relative flex items-end gap-1 rounded-2xl border backdrop-blur-xl backdrop-saturate-150 transition-[box-shadow,border-color]",
        "shadow-[0_0_0_1px_rgb(0_0_0/0.02),0_1px_2px_rgb(0_0_0/0.03),0_8px_20px_rgb(0_0_0/0.05)]",
        "after:pointer-events-none after:absolute after:-inset-4 after:-z-10 after:rounded-2xl after:bg-[radial-gradient(ellipse_at_center,var(--background)_0%,transparent_70%)] after:opacity-50",
        "w-[min(560px,calc(100%-2rem))] py-1 ps-1.5 pe-1",
        layout === "floating"
          ? "absolute start-1/2 bottom-8 z-50 -translate-x-1/2"
          : "relative mb-8 shrink-0 self-center",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function PromptBar(props: PromptBarProps) {
  const {
    layout,
    status,
    pendingCount,
    panelOpen,
    showThreadToggle,
    onSubmit,
    onStop,
    onNewThread,
    newThreadLabel,
    onTogglePanel,
    editorController,
    emptyPlaceholder,
    attentionPulseSeq,
    sendDisabledReason,
  } = props;

  const t = useTranslations();
  const { editor, canSubmit, isEmpty, submit, setSubmitHandler } =
    editorController;

  const isGenerating = status === "generating";
  const busy = isGenerating || status === "applying";
  // The send button doubles as a stop button while a response is
  // streaming, so users don't have to hunt a separate floating
  // control (and the bar stays the single point of intent).
  const showStop = isGenerating && onStop !== undefined;
  const isSendBlocked = sendDisabledReason !== undefined;
  const inputDisabled = busy || isSendBlocked;

  // Glow on attention pulse — kicked from the inspector when the
  // user clicks the AI-suggestions chip so they see the bar light
  // up and connect "the suggestions came from this chat". One-shot
  // 1.4s ring; restart when the seq advances.
  const [attention, setAttention] = useState(false);
  const lastAttentionSeq = useRef(attentionPulseSeq);
  useEffect(() => {
    if (
      attentionPulseSeq === undefined ||
      attentionPulseSeq === lastAttentionSeq.current
    ) {
      return undefined;
    }
    lastAttentionSeq.current = attentionPulseSeq;
    setAttention(true);
    const timer = window.setTimeout(() => {
      setAttention(false);
    }, 1400);
    return () => {
      window.clearTimeout(timer);
    };
  }, [attentionPulseSeq]);

  // Wrap controller.submit so the host's `onSubmit` is the only
  // outbound channel; the editor's draft (HTML) becomes the prompt.
  const submitDraft = useCallback(async () => {
    if (inputDisabled) {
      return;
    }
    await submit((draft) => {
      onSubmit({ prompt: draft.html });
    });
  }, [inputDisabled, onSubmit, submit]);

  // Register Enter handler — TipTap's keymap delegates Enter to
  // the `setSubmitHandler` registered here. Without this, Enter
  // inserts a newline.
  useEffect(() => {
    setSubmitHandler(submitDraft);
    return () => {
      setSubmitHandler(null);
    };
  }, [setSubmitHandler, submitDraft]);

  useEffect(() => {
    editor?.setEditable(!inputDisabled);
    if (inputDisabled) {
      editor?.commands.blur();
    }
  }, [editor, inputDisabled]);

  return (
    <PromptBarShell
      aria-busy={busy}
      aria-label="AI prompt"
      className={cn(
        !inputDisabled && "focus-within:border-foreground/30",
        // Attention pulse — kicked by the inspector chip click to
        // close the panel→producer loop visually. Stronger ring
        // than the busy state because it's transient and meant to
        // catch the eye, not communicate ongoing work.
        attention && !inputDisabled && "border-primary ring-primary/40 ring-4",
      )}
      layout={layout}
      role="toolbar"
    >
      <div className="relative flex min-h-8 min-w-0 flex-1 items-center gap-1.5 px-1.5">
        {isEmpty && busy && (
          <div className="text-muted-foreground pointer-events-none absolute inset-x-1.5 top-1/2 z-10 flex min-w-0 -translate-y-1/2 items-center gap-2 text-[13px]">
            <LoaderCircleIcon
              aria-hidden="true"
              className="size-3.5 shrink-0 animate-spin"
            />
            <span className="truncate">{t("chat.thinking")}</span>
          </div>
        )}
        {isEmpty && !busy && isSendBlocked && (
          <div className="text-muted-foreground pointer-events-none absolute inset-x-1.5 top-1/2 z-10 flex min-w-0 -translate-y-1/2 items-center gap-2 text-[13px]">
            <LoaderCircleIcon
              aria-hidden="true"
              className="size-3.5 shrink-0 animate-spin"
            />
            <span className="truncate">{t("chat.editorLoading")}</span>
          </div>
        )}
        {isEmpty &&
          !busy &&
          !isSendBlocked &&
          emptyPlaceholder !== undefined && (
            <div className="pointer-events-none absolute inset-0 z-10 flex min-w-0 items-center px-1.5">
              {emptyPlaceholder}
            </div>
          )}
        <EditorContent
          // Height is content-driven: a single line of 13px text
          // is ~20px tall (`leading-5`) and the cell's `min-h-8`
          // (2rem) + `items-center` centres it vertically;
          // multiple wrapped lines stay tight. The cell grows up
          // to `max-h-32` before scrolling, and `min-h-0`
          // overrides the provider's `min-h-10` so it shrinks
          // back as the user deletes content.
          className={cn(
            "folio-ai-bar-editor text-foreground min-w-0 flex-1 [&_.ProseMirror]:field-sizing-fixed [&_.ProseMirror]:max-h-32 [&_.ProseMirror]:min-h-0 [&_.ProseMirror]:overflow-y-auto [&_.ProseMirror]:py-1.5 [&_.ProseMirror]:text-[13px] [&_.ProseMirror]:leading-5 [&_.ProseMirror]:select-text [&_.ProseMirror]:focus-visible:outline-none [&_.ProseMirror_p]:my-0",
            isEmpty &&
              emptyPlaceholder !== undefined &&
              "folio-ai-bar-editor--custom-placeholder",
            inputDisabled && "pointer-events-none",
          )}
          editor={editor}
        />
      </div>

      {onNewThread && (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-label={newThreadLabel}
                className="rounded-full"
                disabled={busy}
                onClick={onNewThread}
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                <SquarePenIcon aria-hidden="true" className="size-3.5" />
              </Button>
            }
          />
          <TooltipPopup side="top">{newThreadLabel}</TooltipPopup>
        </Tooltip>
      )}

      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label={showStop ? "Stop response" : "Send prompt"}
              className="rounded-full"
              disabled={showStop ? false : busy || !canSubmit || isSendBlocked}
              onClick={() => {
                if (showStop) {
                  onStop?.();
                  return;
                }
                void submitDraft();
              }}
              size="icon"
              type="button"
            >
              {showStop ? (
                <SquareIcon aria-hidden="true" />
              ) : (
                <ArrowUpIcon aria-hidden="true" />
              )}
            </Button>
          }
        />
        <TooltipPopup side="top">
          {showStop ? "Stop" : canSubmit ? "Send prompt" : "Ask anything"}
        </TooltipPopup>
      </Tooltip>

      {showThreadToggle && (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-expanded={panelOpen}
                aria-label={panelOpen ? "Hide thread" : "Open thread"}
                className="rounded-full"
                onClick={onTogglePanel}
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                {pendingCount > 0 ? (
                  <span className="bg-muted text-foreground inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1.5 text-[11px] font-semibold tabular-nums">
                    {pendingCount}
                  </span>
                ) : (
                  <ChevronDownIcon
                    aria-hidden="true"
                    className={cn(
                      "size-3.5 transition-transform duration-150",
                      panelOpen && "rotate-180",
                    )}
                  />
                )}
              </Button>
            }
          />
          <TooltipPopup side="top">
            {panelOpen ? "Hide thread" : "Open thread"}
          </TooltipPopup>
        </Tooltip>
      )}
    </PromptBarShell>
  );
}

// ===========================================================================
// Thread panel
// ===========================================================================

type ThreadPanelProps = {
  layout: FileAIChatLayout;
  messages: ThreadMessage[];
  focusedId: string | null;
  activeCitationId: string | null;
  showAcceptUI: boolean;
  /** True while an accept is queued waiting for the apply-mode prompt. */
  pendingFirstAccept: boolean;
  onResolveFirstAccept: (mode: AISuggestionApplyMode) => void;
  /** User-set height in px; null = default max-height. Floating only. */
  height: number | null;
  onResize: (next: number | null) => void;
  onAcceptOne: (suggestionId: string) => void;
  onRejectOne: (suggestionId: string) => void;
  onAcceptGroup: (messageId: string) => void;
  onRejectGroup: (messageId: string) => void;
  onFocusSuggestion: (suggestionId: string) => void;
  onActivateCitation: (citation: AICitation) => void;
};

function ThreadPanel(props: ThreadPanelProps) {
  const t = useTranslations();
  const {
    layout,
    messages,
    focusedId,
    activeCitationId,
    showAcceptUI,
    pendingFirstAccept,
    onResolveFirstAccept,
    height,
    onResize,
    onAcceptOne,
    onRejectOne,
    onAcceptGroup,
    onRejectGroup,
    onFocusSuggestion,
    onActivateCitation,
  } = props;

  const panelRef = useRef<HTMLDivElement>(null);
  const isFloating = layout === "floating";

  const handleResizeStart = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = panelRef.current?.getBoundingClientRect().height ?? 360;
    const minHeight = 180;
    const maxHeight = Math.round(window.innerHeight * 0.85);

    const onMove = (ev: PointerEvent) => {
      const next = Math.min(
        maxHeight,
        Math.max(minHeight, startHeight + (startY - ev.clientY)),
      );
      onResize(next);
    };
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "ns-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  };

  return (
    <div
      ref={panelRef}
      // Floating: a transient overlay above the file, dismissable
      // with Escape — `dialog` is the right semantic.
      // Standalone: a chat transcript that grows as the assistant
      // streams. `role="log"` is the ARIA pattern for "live region
      // where new messages append in meaningful order"; we set
      // `aria-live="polite"` explicitly (most screen readers infer
      // it from `log`, but being explicit is portable) and
      // `aria-relevant="additions"` so existing-bubble updates
      // (e.g., status flips) don't get re-announced.
      role={isFloating ? "dialog" : "log"}
      aria-label="AI thread"
      aria-live={isFloating ? undefined : "polite"}
      aria-relevant={isFloating ? undefined : "additions"}
      style={
        isFloating && height !== null
          ? { height: `${height}px`, maxHeight: "85dvh" }
          : undefined
      }
      className={cn(
        "text-popover-foreground flex flex-col overflow-hidden",
        isFloating
          ? cn(
              // Glass-card thread. Heavy on the transparency at rest so the
              // doc shines through and the blur is doing visible work; firms
              // up sharply on hover/focus when the user is engaging.
              // bottom-[88px] = bar at bottom-8 (32px) + bar height ~44px +
              // ~12px gap. Keep this in sync with the bar's `bottom-8`.
              "absolute start-1/2 bottom-[88px] z-40 min-h-[200px] w-[min(560px,calc(100%-2rem))] -translate-x-1/2 rounded-2xl border",
              "bg-popover/35 border-border/50",
              // Strong blur + saturation so the glass refraction is obvious.
              "[backdrop-filter:blur(28px)_saturate(180%)] [-webkit-backdrop-filter:blur(28px)_saturate(180%)]",
              // Subtle inset highlight on the top edge for the glass look.
              "before:bg-foreground/[0.06] before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:h-px",
              // Hover/focus: firmer, almost solid, for readability while
              // engaging with the thread.
              "hover:bg-popover/92 focus-within:bg-popover/92 hover:border-border focus-within:border-border",
              "transition-[background-color,border-color] duration-200 ease-out",
              "shadow-[0_1px_2px_rgb(0_0_0/0.04),0_16px_48px_rgb(0_0_0/0.10)]",
              height === null && "max-h-[min(58dvh,520px)]",
              "animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-1",
            )
          : // Standalone: fills the chat tab between the bar and the
            // top of the container. Parent sets the bounding height,
            // we just stretch and scroll inside.
            "min-h-0 flex-1",
      )}
    >
      {/* Top-edge resize handle — floating only. Sits a few px
       *  ABOVE the card's top border so it reads as a separate
       *  affordance, not as part of the card chrome. Same idiom
       *  the table uses for column-resize: thin pill that's
       *  visible at rest, brightens to primary on hover/drag.
       *  Double-click resets to default height. */}
      {isFloating && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize thread"
          onPointerDown={handleResizeStart}
          onDoubleClick={() => onResize(null)}
          className="group absolute inset-x-0 -top-3 z-20 flex h-3 cursor-ns-resize touch-none items-center justify-center select-none"
        >
          <div className="bg-muted-foreground/50 group-hover:bg-primary h-1 w-12 rounded-full transition-colors" />
        </div>
      )}

      {pendingFirstAccept && (
        <div
          role="note"
          className="border-border/40 bg-background/85 flex flex-col gap-1.5 border-b px-3 py-2 backdrop-blur-md"
        >
          <span className="text-[12px] font-medium">
            {t("chat.applyMode.title")}
          </span>
          <span className="text-muted-foreground text-[11px]">
            {t("chat.applyMode.description")}
          </span>
          <div className="mt-0.5 flex items-center gap-1.5">
            <Button
              type="button"
              size="xs"
              className="rounded-md"
              onClick={() => onResolveFirstAccept("tracked-changes")}
            >
              {t("chat.applyMode.tracked")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="rounded-md"
              onClick={() => onResolveFirstAccept("direct")}
            >
              {t("chat.applyMode.direct")}
            </Button>
          </div>
        </div>
      )}

      <div
        className={cn(
          "flex flex-1 flex-col gap-2.5 overflow-y-auto p-3",
          // Floating-only: reserve space at top for the resize strip
          // when there's no confirm banner above the messages.
          isFloating && !pendingFirstAccept && "pt-3.5",
        )}
        style={{ scrollbarGutter: "stable" }}
      >
        {messages.length === 0 && !isFloating ? (
          // Standalone empty state. Floating mode never reaches this
          // branch because the thread doesn't render until the first
          // message arrives; standalone always renders, so we need a
          // gentle landing surface instead of a blank canvas.
          <div className="text-muted-foreground/80 m-auto flex max-w-[28ch] flex-col items-center gap-1 text-center text-[12px] text-balance">
            <span className="text-foreground/80 text-[13px] font-medium">
              Start a chat
            </span>
            <span>
              Ask about your matter, draft a snippet, or request a quick
              research note.
            </span>
          </div>
        ) : (
          messages.map((m) =>
            m.role === "user" ? (
              <UserBubble key={m.id} message={m} />
            ) : (
              <AssistantBubble
                key={m.id}
                message={m}
                focusedId={focusedId}
                activeCitationId={activeCitationId}
                showAcceptUI={showAcceptUI}
                onAcceptOne={onAcceptOne}
                onRejectOne={onRejectOne}
                onAcceptGroup={onAcceptGroup}
                onRejectGroup={onRejectGroup}
                onFocusSuggestion={onFocusSuggestion}
                onActivateCitation={onActivateCitation}
              />
            ),
          )
        )}
      </div>
    </div>
  );
}

function UserBubble({ message }: { message: UserThreadMessage }) {
  const text =
    message.prompt.length > 0 ? message.prompt : "(no prompt — preset only)";
  return (
    <Message from="user">
      <MessageContent className="gap-1 px-3 py-1.5 text-[13px]">
        {message.presetId && (
          <span className="text-info bg-info/10 inline-flex w-fit items-center gap-0.5 rounded px-1.5 text-[10.5px] font-medium tabular-nums">
            /{message.presetId}
          </span>
        )}
        <span className="whitespace-pre-wrap">{text}</span>
        {message.pastedText && (
          <span className="text-info bg-info/10 inline-flex w-fit items-center gap-0.5 rounded px-1.5 text-[10.5px] font-medium tabular-nums">
            Pasted · {message.pastedText.length.toLocaleString()} chars
          </span>
        )}
      </MessageContent>
    </Message>
  );
}

type AssistantBubbleProps = {
  message: AssistantThreadMessage;
  focusedId: string | null;
  activeCitationId: string | null;
  showAcceptUI: boolean;
  onAcceptOne: (id: string) => void;
  onRejectOne: (id: string) => void;
  onAcceptGroup: (messageId: string) => void;
  onRejectGroup: (messageId: string) => void;
  onFocusSuggestion: (id: string) => void;
  onActivateCitation: (citation: AICitation) => void;
};

function AssistantBubble(props: AssistantBubbleProps) {
  const {
    message,
    focusedId,
    activeCitationId,
    showAcceptUI,
    onAcceptOne,
    onRejectOne,
    onAcceptGroup,
    onRejectGroup,
    onFocusSuggestion,
    onActivateCitation,
  } = props;

  const pendingCount = message.suggestions.filter(
    (s) => s.status === "pending",
  ).length;

  return (
    <Message from="assistant">
      <MessageContent className="gap-1.5 text-[13px] leading-relaxed">
        {message.status === "loading" && (
          <span className="text-muted-foreground inline-flex items-center gap-2 text-[12px]">
            <span
              className="border-border border-t-foreground inline-block size-3 animate-spin rounded-full border-[1.5px]"
              aria-hidden="true"
            />
            Thinking…
          </span>
        )}
        {message.status === "error" && (
          <span className="text-destructive text-[12px]">
            {message.error ?? "Something went wrong."}
          </span>
        )}
        {message.text && message.text.length > 0 && (
          <MessageResponse className="text-[13px] leading-relaxed [&_p]:my-0">
            {message.text}
          </MessageResponse>
        )}
        {message.citations.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-muted-foreground text-[11px]">Sources:</span>
            {message.citations.map((c) => (
              <CitationChip
                key={c.id}
                citation={c}
                active={activeCitationId === c.id}
                onActivate={onActivateCitation}
              />
            ))}
          </div>
        )}
        {message.suggestions.length > 0 && (
          <div className="flex flex-col gap-2">
            {showAcceptUI && pendingCount > 1 && (
              <div className="flex items-center gap-1.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="rounded-md"
                  onClick={() => onAcceptGroup(message.id)}
                >
                  Accept all {pendingCount}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="rounded-md"
                  onClick={() => onRejectGroup(message.id)}
                >
                  Reject all
                </Button>
              </div>
            )}
            {message.suggestions.map((s) => (
              <SuggestionCard
                key={s.id}
                suggestion={s}
                focused={focusedId === s.id}
                showAcceptUI={showAcceptUI}
                onAccept={onAcceptOne}
                onReject={onRejectOne}
                onFocus={onFocusSuggestion}
              />
            ))}
          </div>
        )}
      </MessageContent>
    </Message>
  );
}

type CitationChipProps = {
  citation: AICitation;
  active: boolean;
  onActivate: (citation: AICitation) => void;
};

function CitationChip(props: CitationChipProps) {
  const { citation, active, onActivate } = props;
  const sourceLabel =
    citation.source.kind === "pdf-bbox"
      ? `Page ${citation.source.pageNumber}`
      : "In document";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className={cn(
              "text-info bg-info/10 hover:bg-info/15 inline-flex h-5 items-center rounded-md px-1.5 text-[11px] font-medium tabular-nums transition-colors",
              active && "bg-info/25 ring-info/40 ring-1",
            )}
            onClick={() => onActivate(citation)}
            aria-label={`Open citation ${citation.label}`}
          >
            [{citation.label}]
          </button>
        }
      />
      <TooltipPopup side="top" className="max-w-[260px]">
        <div className="flex flex-col gap-0.5">
          <span className="text-[10.5px] tracking-wider uppercase opacity-75">
            {sourceLabel}
          </span>
          <span className="text-[12px] italic">“{citation.quote}”</span>
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}

type SuggestionCardProps = {
  suggestion: AISuggestion;
  focused: boolean;
  showAcceptUI: boolean;
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
  onFocus: (id: string) => void;
};

function SuggestionCard(props: SuggestionCardProps) {
  const { suggestion, focused, showAcceptUI, onAccept, onReject, onFocus } =
    props;
  const isResolvable =
    suggestion.status === "pending" || suggestion.status === "stale";

  return (
    <div
      data-status={suggestion.status}
      className={cn(
        "border-border/60 bg-background/60 rounded-lg border px-3 py-2 transition-colors",
        focused && "border-foreground/40 bg-muted/40",
      )}
    >
      <button
        type="button"
        className="text-muted-foreground flex w-full cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 text-start text-[11px]"
        onClick={() => onFocus(suggestion.id)}
        aria-label={`Focus suggestion: ${suggestion.topic}`}
      >
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            SEVERITY_DOT_CLASS[suggestion.severity],
          )}
          aria-hidden="true"
        />
        <span className="text-foreground font-medium">{suggestion.topic}</span>
        <span aria-hidden="true">·</span>
        <span>{SEVERITY_LABEL[suggestion.severity]}</span>
        {suggestion.status === "stale" && (
          <span className="bg-destructive/12 text-destructive ms-1 inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium tracking-wider uppercase">
            Stale
          </span>
        )}
        {suggestion.status === "accepted" && (
          <span className="bg-success/15 text-success ms-1 inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium tracking-wider uppercase">
            Applied
          </span>
        )}
        {suggestion.status === "rejected" && (
          <span className="bg-muted text-muted-foreground ms-1 inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium tracking-wider uppercase">
            Rejected
          </span>
        )}
      </button>

      <div className="bg-muted text-muted-foreground mt-2 flex flex-col gap-0.5 rounded-md px-2.5 py-1.5 text-[12.5px] leading-snug text-pretty break-words">
        <div className="flex gap-1.5">
          <span
            className="text-muted-foreground w-3 shrink-0 text-center tabular-nums"
            aria-hidden="true"
          >
            −
          </span>
          <span className="decoration-muted-foreground/70 line-through">
            {suggestion.originalText}
          </span>
        </div>
      </div>
      <div className="bg-muted text-foreground mt-1 flex flex-col gap-0.5 rounded-md px-2.5 py-1.5 text-[12.5px] leading-snug text-pretty break-words">
        <div className="flex gap-1.5">
          <span
            className="text-muted-foreground w-3 shrink-0 text-center tabular-nums"
            aria-hidden="true"
          >
            +
          </span>
          <span>
            {suggestion.suggestedText.length === 0
              ? "(remove)"
              : suggestion.suggestedText}
          </span>
        </div>
      </div>

      {suggestion.rationale && (
        <p className="text-muted-foreground mt-1.5 text-xs leading-snug text-pretty">
          {suggestion.rationale}
        </p>
      )}

      {showAcceptUI && isResolvable && (
        <div className="mt-2 flex items-center gap-1.5">
          <Button
            type="button"
            size="xs"
            className="rounded-md"
            onClick={() => onAccept(suggestion.id)}
            disabled={suggestion.status === "stale"}
          >
            <CheckIcon aria-hidden="true" />
            Accept
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="rounded-md"
            onClick={() => onReject(suggestion.id)}
          >
            Reject
          </Button>
        </div>
      )}
    </div>
  );
}
