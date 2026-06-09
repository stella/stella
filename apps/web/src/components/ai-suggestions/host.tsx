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
import type {
  ComponentProps,
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
} from "react";

import {
  ArrowUpIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  LoaderCircleIcon,
  RotateCcwIcon,
  SquareIcon,
  SquarePenIcon,
  WandSparklesIcon,
} from "lucide-react";
import type { EditorView } from "prosemirror-view";
import { useTranslations } from "use-intl";

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
  AISuggestionPreset,
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

import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import { useChatComposerWiring } from "@/components/chat-editor-provider";
import type { ChatEditorController } from "@/components/chat-editor-provider";
import { PromptEditorContent } from "@/components/prompt-editor";
import { usePulse } from "@/hooks/use-pulse";
import type { TranslationKey } from "@/i18n/types";
import { isValueTypeKind, VALUE_TYPE_META } from "@/lib/value-types";

import type {
  AssistantThreadMessage,
  FileAIChatConfig,
  FileAIChatStatus,
  ThreadMessage,
  UserThreadMessage,
} from "./types";
import { useAISuggestionThread } from "./use-ai-suggestion-thread";

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
  return container.textContent.trim();
}

function writeStoredApplyMode(mode: AISuggestionApplyMode): void {
  try {
    localStorage.setItem(APPLY_MODE_STORAGE_KEY, mode);
  } catch {
    // best-effort; lack of persistence just means we'll re-ask next session
  }
}

/**
 * Composer commands (plain text after `htmlToPromptText`) that reset
 * the thread instead of generating a response.
 */
const NEW_THREAD_COMMANDS = new Set(["/new", "/clear"]);

/**
 * The raw input a generation was started with (composer HTML plus
 * optional preset/paste payload). Kept verbatim so a stopped run can
 * be retried with the exact same input.
 */
type GenerateBarInput = {
  prompt: string;
  presetId?: string;
  pastedText?: string;
};

const SEVERITY_DOT_CLASS: Record<AISuggestionSeverity, string> = {
  substantive: "bg-destructive",
  style: "bg-foreground/55",
  typo: "bg-muted-foreground",
};

const SEVERITY_LABEL_KEYS = {
  substantive: "chat.suggestionSeverity.substantive",
  style: "chat.suggestionSeverity.style",
  typo: "chat.suggestionSeverity.typo",
} as const satisfies Record<AISuggestionSeverity, TranslationKey>;

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
  const t = useTranslations();
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
  const {
    messages,
    setMessages,
    allSuggestions,
    allCitations,
    pendingAccepts,
    setPendingAccepts,
    updateAssistantMessage,
    updateSuggestion,
    applyResultToMessages,
  } = useAISuggestionThread({ editorView });
  const [panelOpen, setPanelOpen] = useState(false);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [activeCitationId, setActiveCitationId] = useState<string | null>(null);
  /**
   * User-set panel height in px. Null means "use the default
   * max-height" (~58% of viewport). Set on drag of the resize
   * handle at the top of the panel.
   */
  const [panelHeight, setPanelHeight] = useState<number | null>(null);

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

  /**
   * Input of the most recently started generation, kept so a
   * user-initiated stop can offer Retry. Only `handleStop` promotes
   * it into `retryInput`; normal completion never does.
   */
  const lastGenerateInput = useRef<GenerateBarInput | null>(null);
  /**
   * When non-null, the bar's action button shows Retry (re-sending
   * this input) instead of the send arrow. Set on stop; cleared by
   * typing a new draft, Escape, a new thread, or starting any
   * generation.
   */
  const [retryInput, setRetryInput] = useState<GenerateBarInput | null>(null);

  // ---- derived state -------------------------------------------------------

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

  let status: FileAIChatStatus = "idle";
  if (generating) {
    status = "generating";
  } else if (pendingCount > 0) {
    status = "review-ready";
  }

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

  // ---- stop / new thread ---------------------------------------------------

  /**
   * Cancels the in-flight generation. Bumping the run token makes the
   * pending `onGenerate` promise resolve against a stale token (its
   * result is dropped); flipping the loading assistant bubble to an
   * error returns the derived bar status to idle.
   */
  const handleStop = useCallback(() => {
    generationToken.current += 1;
    setRetryInput(lastGenerateInput.current);
    setMessages((prev) =>
      prev.map<ThreadMessage>((m) =>
        m.role === "assistant" && m.status === "loading"
          ? {
              id: m.id,
              role: "assistant",
              text: m.text,
              suggestions: m.suggestions,
              citations: m.citations,
              mode: m.mode,
              createdAt: m.createdAt,
              status: "error",
              error: t("chat.stopped"),
            }
          : m,
      ),
    );
  }, [setMessages, t]);

  /**
   * Resets the thread: drops messages, queued accepts, focus, and the
   * first-accept prompt, then clears this host's suggestion
   * decorations from the editor. The decoration-push effect skips
   * empty lists (to avoid racing the review-store writer), so the
   * empty push has to happen explicitly here. The run-token bump
   * keeps a generation started before the reset from landing into
   * the fresh thread.
   */
  const handleNewThread = useCallback(() => {
    generationToken.current += 1;
    setRetryInput(null);
    setMessages([]);
    setPendingAccepts([]);
    setPendingFirstAccept(null);
    setFocusedId(null);
    setActiveCitationId(null);
    setPanelOpen(false);
    if (editorView) {
      const meta = setAISuggestionsMeta([]);
      editorView.dispatch(editorView.state.tr.setMeta(meta.key, meta.payload));
    }
  }, [editorView, setMessages, setPendingAccepts]);

  // ---- generate ------------------------------------------------------------

  const handleGenerate = useCallback(
    async (input: GenerateBarInput) => {
      if (generating) {
        return;
      }

      // The bar emits prompt as HTML from the TipTap editor — entity
      // mentions live as `<entity-mention data-label="…">` nodes.
      // Flatten to plain text (with mentions inlined as `@Label`) so
      // pattern-matching generators don't have to parse HTML.
      const promptText = htmlToPromptText(input.prompt);

      if (NEW_THREAD_COMMANDS.has(promptText)) {
        handleNewThread();
        return;
      }

      lastGenerateInput.current = input;
      setRetryInput(null);

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

      let fullPrompt = promptText;
      if (input.pastedText) {
        fullPrompt =
          promptText.length === 0
            ? input.pastedText
            : `${promptText}\n\n${input.pastedText}`;
      }

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
          id: m.id,
          role: "assistant",
          mode: m.mode,
          createdAt: m.createdAt,
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
          id: m.id,
          role: "assistant",
          mode: m.mode,
          createdAt: m.createdAt,
          text: m.text,
          suggestions: m.suggestions,
          citations: m.citations,
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
      setMessages,
      mode,
      handleNewThread,
    ],
  );

  // ---- retry after stop ------------------------------------------------------

  /** Re-runs the prompt whose generation the user just stopped. */
  const handleRetry = useCallback(() => {
    const input = retryInput;
    if (input === null) {
      return;
    }
    setRetryInput(null);
    void handleGenerate(input);
  }, [retryInput, handleGenerate]);

  // A non-empty draft means the user has moved on to a new prompt;
  // drop the retry offer so the action button reverts to send (and
  // stays send even if they delete the draft again).
  const composerIsEmpty = editorController.isEmpty;
  useEffect(() => {
    if (!composerIsEmpty && retryInput !== null) {
      setRetryInput(null);
    }
  }, [composerIsEmpty, retryInput]);

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

  // Report each successfully applied suggestion to the mounting surface
  // (config.onSuggestionApplied), from whichever path applied it.
  const notifyApplied = useCallback(
    (candidates: AISuggestion[], appliedIds: readonly string[]) => {
      const onApplied = config.onSuggestionApplied;
      if (!onApplied) {
        return;
      }
      const applied = new Set(appliedIds);
      for (const suggestion of candidates) {
        if (applied.has(suggestion.id)) {
          onApplied(suggestion);
        }
      }
    },
    [config.onSuggestionApplied],
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
      notifyApplied([target], result.applied);
    },
    [
      findSuggestion,
      readOnly,
      config,
      editorView,
      author,
      applyResultToMessages,
      notifyApplied,
      setPendingAccepts,
    ],
  );

  const handleAcceptOne = useCallback(
    (suggestionId: string) => {
      // First-time accept: ask whether to apply with tracked changes,
      // remember the answer, and defer this accept until they pick.
      // Surfaces with a pinned mode (promptForApplyMode: false) skip the gate.
      if (applyModeStored === null && config.promptForApplyMode !== false) {
        const target = findSuggestion(suggestionId);
        if (!target || target.status !== "pending") {
          return;
        }
        setPendingFirstAccept({ kind: "one", suggestionId });
        return;
      }
      acceptOneAtMode(suggestionId, applyMode);
    },
    [
      applyModeStored,
      config.promptForApplyMode,
      findSuggestion,
      acceptOneAtMode,
      applyMode,
    ],
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
      notifyApplied(targets, result.applied);
    },
    [
      messages,
      readOnly,
      config,
      editorView,
      author,
      applyResultToMessages,
      notifyApplied,
      setPendingAccepts,
    ],
  );

  const handleAcceptGroup = useCallback(
    (messageId: string) => {
      if (applyModeStored === null && config.promptForApplyMode !== false) {
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
    [
      applyModeStored,
      config.promptForApplyMode,
      messages,
      acceptGroupAtMode,
      applyMode,
    ],
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
    notifyApplied(targets, result.applied);
  }, [
    readOnly,
    editorView,
    pendingAccepts,
    allSuggestions,
    applyMode,
    author,
    applyResultToMessages,
    notifyApplied,
    setPendingAccepts,
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

  // ---- suggestion stepper --------------------------------------------------

  // Pending suggestions in document order — the go-over-the-doc review walks
  // them top to bottom.
  const orderedPending = useMemo(
    () =>
      allSuggestions
        .filter((s) => s.status === "pending")
        .toSorted((a, b) => a.range.from - b.range.from),
    [allSuggestions],
  );

  const focusedPendingIndex = focusedId
    ? orderedPending.findIndex((s) => s.id === focusedId)
    : -1;
  const stepperIndex = focusedPendingIndex === -1 ? 0 : focusedPendingIndex;

  const stepBy = useCallback(
    (delta: number) => {
      if (orderedPending.length === 0) {
        return;
      }
      const target = orderedPending.at(
        (stepperIndex + delta + orderedPending.length) % orderedPending.length,
      );
      if (target) {
        handleFocusSuggestion(target.id);
      }
    },
    [orderedPending, stepperIndex, handleFocusSuggestion],
  );

  // Accept/dismiss the focused suggestion and advance to the next pending one
  // (the one after it in document order, else the previous).
  const resolveCurrent = useCallback(
    (action: "accept" | "dismiss") => {
      const current = orderedPending.at(stepperIndex);
      if (!current) {
        return;
      }
      const next =
        orderedPending.at(stepperIndex + 1) ??
        (stepperIndex > 0 ? orderedPending.at(stepperIndex - 1) : undefined);
      if (action === "accept") {
        handleAcceptOne(current.id);
      } else {
        handleRejectOne(current.id);
      }
      if (next) {
        handleFocusSuggestion(next.id);
      } else {
        setFocusedId(null);
      }
    },
    [
      orderedPending,
      stepperIndex,
      handleAcceptOne,
      handleRejectOne,
      handleFocusSuggestion,
    ],
  );

  // When a generation lands new suggestions, jump to the first one so the
  // review starts immediately.
  const seenSuggestionIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const seen = seenSuggestionIdsRef.current;
    const fresh = orderedPending.find((s) => !seen.has(s.id));
    for (const s of orderedPending) {
      seen.add(s.id);
    }
    if (fresh) {
      handleFocusSuggestion(fresh.id);
    }
  }, [orderedPending, handleFocusSuggestion]);

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

  // Escape closes the floating thread panel and dismisses a pending
  // retry offer. The listener is only installed while it has work to
  // do: in standalone there's no panel to close (the thread is always
  // visible alongside the bar), so only an active retry offer keeps
  // the binding alive there.
  const panelClosableByEscape = layout === "floating" && panelOpen;
  useEffect(() => {
    if (!panelClosableByEscape && retryInput === null) {
      return undefined;
    }
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") {
        return;
      }
      setRetryInput(null);
      if (panelClosableByEscape) {
        setPanelOpen(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", handler);
    };
  }, [panelClosableByEscape, retryInput]);

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
      presets={config.presets}
      threadHasMessages={hasMessages}
      onSubmit={(input) => {
        void handleGenerate(input);
      }}
      onStop={handleStop}
      onRetry={retryInput !== null ? handleRetry : undefined}
      onNewThread={hasMessages ? handleNewThread : undefined}
      newThreadLabel={t("chat.newChat")}
      onTogglePanel={() => setPanelOpen((v) => !v)}
      editorController={editorController}
    />
  );

  // The go-over-the-doc review bar: floats above the prompt bar while there
  // are pending suggestions, stepping through them in document order.
  const stepperBar =
    layout === "floating" &&
    !threadVisible &&
    mode === "edit" &&
    showAcceptUI &&
    orderedPending.length > 0 ? (
      <SuggestionStepper
        index={stepperIndex}
        total={orderedPending.length}
        onStep={stepBy}
        onAccept={() => resolveCurrent("accept")}
        onDismiss={() => resolveCurrent("dismiss")}
      />
    ) : null;

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
      {stepperBar}
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
  canSubmitNow?: (() => boolean) | undefined;
  onSubmit: (input: { prompt: string; presetId?: string }) => void;
  /**
   * Pre-saved prompts surfaced as chips above the empty bar. Clicking a
   * chip — or pressing Tab while the input is empty (first preset) —
   * accepts and sends it in one step. Hidden once the thread has any
   * message; starting a new thread brings them back.
   */
  presets?: AISuggestionPreset[] | undefined;
  threadHasMessages?: boolean | undefined;
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
  /**
   * Offered after a user-initiated stop: while provided AND the
   * composer is empty, the send arrow becomes a retry button that
   * re-runs the stopped prompt. The owner clears it (prop becomes
   * undefined) once the user types a new draft, presses Escape, or
   * starts a new thread.
   */
  onRetry?: (() => void) | undefined;

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
  /**
   * When true the composer keeps accepting input while a response
   * streams: a send is queued by `useChatSession` and dispatched
   * once the turn finishes. A dedicated Stop button appears beside
   * Send instead of the send button morphing into Stop.
   */
  queueWhileGenerating?: boolean | undefined;
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
    <span className="text-foreground-muted truncate text-[13px] leading-5">
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
        "group/bar bg-background/75 border-foreground/15 relative flex items-end gap-1 rounded-2xl border backdrop-blur-xl backdrop-saturate-150 transition-[box-shadow,border-color]",
        "shadow-[0_0_0_1px_rgb(0_0_0/0.02),0_1px_2px_rgb(0_0_0/0.03),0_8px_20px_rgb(0_0_0/0.05)]",
        "after:pointer-events-none after:absolute after:-inset-6 after:-z-10 after:rounded-3xl after:bg-[radial-gradient(ellipse_at_center,var(--background)_0%,transparent_75%)] after:opacity-90",
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

type SuggestionStepperProps = {
  index: number;
  total: number;
  onStep: (delta: number) => void;
  onAccept: () => void;
  onDismiss: () => void;
};

/** Compact floating review bar: step through the pending suggestions in
 *  document order and accept/dismiss each in place. */
function SuggestionStepper({
  index,
  total,
  onStep,
  onAccept,
  onDismiss,
}: SuggestionStepperProps) {
  const t = useTranslations();
  return (
    <div className="bg-background/75 border-foreground/15 absolute start-1/2 bottom-26 z-50 flex -translate-x-1/2 items-center gap-1 rounded-full border px-1.5 py-1 shadow-[0_0_0_1px_rgb(0_0_0/0.02),0_1px_2px_rgb(0_0_0/0.03),0_8px_20px_rgb(0_0_0/0.05)] backdrop-blur-xl backdrop-saturate-150">
      <Button
        aria-label={t("common.previous")}
        onClick={() => onStep(-1)}
        size="icon-sm"
        variant="ghost"
      >
        <ChevronLeftIcon />
      </Button>
      <span className="text-muted-foreground min-w-12 text-center text-xs tabular-nums">
        {t("chat.suggestionStep", {
          current: String(index + 1),
          total: String(total),
        })}
      </span>
      <Button
        aria-label={t("common.next")}
        onClick={() => onStep(1)}
        size="icon-sm"
        variant="ghost"
      >
        <ChevronRightIcon />
      </Button>
      <Button className="ms-1" onClick={onDismiss} size="sm" variant="ghost">
        {t("folio.dismiss")}
      </Button>
      <Button onClick={onAccept} size="sm">
        {t("common.accept")}
      </Button>
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
    canSubmitNow,
    onSubmit,
    presets,
    threadHasMessages = false,
    onStop,
    onRetry,
    onNewThread,
    newThreadLabel,
    onTogglePanel,
    editorController,
    emptyPlaceholder,
    attentionPulseSeq,
    sendDisabledReason,
    queueWhileGenerating = false,
  } = props;

  const t = useTranslations();
  const { canSubmit, editor, isEmpty } = editorController;

  const isGenerating = status === "generating";
  const busy = isGenerating || status === "applying";
  // The send button doubles as a stop button while a response is
  // streaming, so users don't have to hunt a separate floating
  // control (and the bar stays the single point of intent).
  const showStop = isGenerating && onStop !== undefined;
  const isSendBlocked = sendDisabledReason !== undefined;
  const inputDisabled = isSendBlocked;
  const submitDisabled = busy || isSendBlocked;
  // With queuing enabled the composer keeps accepting input while a
  // response streams — `useChatSession` holds the send until the
  // turn finishes. The send button stays a send button; a dedicated
  // Stop button sits beside it instead of the send button morphing.
  const composerSubmitDisabled = queueWhileGenerating
    ? status === "applying" || isSendBlocked
    : submitDisabled;
  const morphSendToStop = showStop && !queueWhileGenerating;
  const showQueueStopButton = showStop && queueWhileGenerating;
  // After a stop the send arrow becomes Retry until the user starts
  // a new draft (the owner also clears `onRetry` then; the `isEmpty`
  // gate just avoids a one-render flash before that state lands).
  const morphSendToRetry =
    !morphSendToStop &&
    onRetry !== undefined &&
    isEmpty &&
    !busy &&
    !isSendBlocked;

  // Glow on attention pulse — kicked from the inspector when the
  // user clicks the AI-suggestions chip so they see the bar light
  // up and connect "the suggestions came from this chat". One-shot
  // 1.4s ring; restart when the seq advances.
  const { isPulsing: attention, pulse: triggerAttention } = usePulse(1400);
  const lastAttentionSeq = useRef(attentionPulseSeq);
  useEffect(() => {
    if (
      attentionPulseSeq === undefined ||
      attentionPulseSeq === lastAttentionSeq.current
    ) {
      return;
    }
    lastAttentionSeq.current = attentionPulseSeq;
    triggerAttention();
  }, [attentionPulseSeq, triggerAttention]);

  // The bar emits `{ prompt }`; the underlying composer emits the
  // raw editor draft. Adapting here lets the rest of the wiring
  // (Enter handler, blur/setEditable, submit gating) stay shared.
  const handleComposerSubmit = useCallback(
    (draft: { html: string }) => {
      onSubmit({ prompt: draft.html });
    },
    [onSubmit],
  );

  const { submitDraft } = useChatComposerWiring({
    controller: editorController,
    inputDisabled,
    onSubmit: handleComposerSubmit,
    onSubmitGuard: canSubmitNow,
    submitDisabled: composerSubmitDisabled,
  });

  // Preset chips: visible over the empty idle bar; click — or Tab with an
  // empty input — accepts and sends the preset in one step.
  const presetChipsVisible =
    layout === "floating" &&
    !panelOpen &&
    !threadHasMessages &&
    presets !== undefined &&
    presets.length > 0 &&
    isEmpty &&
    !busy &&
    !isSendBlocked;
  const submitPreset = useCallback(
    (preset: AISuggestionPreset) => {
      if (canSubmitNow !== undefined && !canSubmitNow()) {
        return;
      }
      onSubmit({ prompt: preset.prompt, presetId: preset.id });
    },
    [canSubmitNow, onSubmit],
  );
  // Tab with an empty input writes the first preset INTO the composer (the
  // user can edit before sending); clicking a chip accepts and sends as-is.
  const handleShellKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      if (event.key !== "Tab" || event.shiftKey || !presetChipsVisible) {
        return;
      }
      const first = presets.at(0);
      if (!first || !editor) {
        return;
      }
      event.preventDefault();
      editor.chain().focus().insertContent(first.prompt).run();
    },
    [presetChipsVisible, presets, editor],
  );

  return (
    <PromptBarShell
      aria-busy={busy}
      aria-label={t("chat.aiPrompt")}
      onKeyDownCapture={handleShellKeyDown}
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
      tabIndex={-1}
    >
      {presetChipsVisible && (
        <div className="absolute start-1 bottom-full mb-3 flex flex-col items-start gap-1.5">
          {presets.map((preset) => (
            <Button
              aria-keyshortcuts="Tab"
              className="bg-background/75 text-foreground h-9 gap-2.5 rounded-full border-none px-3 text-[13px] font-medium shadow-[0_1px_2px_rgb(0_0_0/0.03),0_8px_20px_rgb(0_0_0/0.05)] backdrop-blur-xl backdrop-saturate-150"
              key={preset.id}
              onClick={() => submitPreset(preset)}
              size="sm"
              type="button"
              variant="ghost"
            >
              <WandSparklesIcon aria-hidden="true" className="size-4" />
              {preset.label}
            </Button>
          ))}
        </div>
      )}
      {layout === "floating" && pendingCount > 0 && (
        <span className="flex h-8 shrink-0 items-center ps-0.5">
          <span className="bg-muted text-foreground inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1.5 text-[11px] font-semibold tabular-nums">
            {pendingCount}
          </span>
        </span>
      )}
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
        <PromptEditorContent
          // Height is content-driven: a single line of 13px text
          // is ~20px tall (`leading-5`) and the cell's `min-h-8`
          // (2rem) + `items-center` centres it vertically;
          // multiple wrapped lines stay tight. The cell grows up
          // to `max-h-32` before scrolling, and `min-h-0`
          // overrides the provider's `min-h-10` so it shrinks
          // back as the user deletes content.
          className={cn(
            "folio-ai-bar-editor text-foreground min-w-0 flex-1 [&_.ProseMirror]:field-sizing-fixed [&_.ProseMirror]:max-h-32 [&_.ProseMirror]:min-h-0 [&_.ProseMirror]:overflow-y-auto [&_.ProseMirror]:py-1.5 [&_.ProseMirror]:text-[13px] [&_.ProseMirror]:leading-5 [&_.ProseMirror]:select-text [&_.ProseMirror]:focus-visible:outline-none [&_.ProseMirror_p]:my-0",
            // Suppress the composer's own placeholder whenever the host
            // renders an overlay in the same cell (custom placeholder, the
            // busy "working" label, or the editor-loading label) — otherwise
            // the two texts paint on top of each other.
            isEmpty &&
              (emptyPlaceholder !== undefined || busy || isSendBlocked) &&
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

      {showQueueStopButton && (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-label={t("chat.stopResponse")}
                className="rounded-full"
                onClick={() => onStop()}
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                <SquareIcon aria-hidden="true" className="size-3.5" />
              </Button>
            }
          />
          <TooltipPopup side="top">{t("chat.stopResponse")}</TooltipPopup>
        </Tooltip>
      )}

      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label={(() => {
                if (morphSendToStop) {
                  return t("chat.stopResponse");
                }
                if (morphSendToRetry) {
                  return t("common.retry");
                }
                return t("chat.sendPrompt");
              })()}
              className="rounded-full"
              disabled={
                morphSendToStop || morphSendToRetry
                  ? false
                  : composerSubmitDisabled || !canSubmit
              }
              onClick={() => {
                if (morphSendToStop) {
                  onStop();
                  return;
                }
                if (morphSendToRetry) {
                  onRetry();
                  return;
                }
                void submitDraft();
              }}
              size="icon"
              type="button"
            >
              {(() => {
                if (morphSendToStop) {
                  return <SquareIcon aria-hidden="true" />;
                }
                if (morphSendToRetry) {
                  return <RotateCcwIcon aria-hidden="true" />;
                }
                return <ArrowUpIcon aria-hidden="true" />;
              })()}
            </Button>
          }
        />
        <TooltipPopup side="top">
          {(() => {
            if (morphSendToStop) {
              return t("chat.stopResponse");
            }
            if (morphSendToRetry) {
              return t("common.retry");
            }
            if (canSubmit) {
              return t("chat.sendPrompt");
            }
            return t("chat.askAnything");
          })()}
        </TooltipPopup>
      </Tooltip>

      {showThreadToggle && (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-expanded={panelOpen}
                aria-label={
                  panelOpen ? t("chat.hideThread") : t("chat.openThread")
                }
                className="rounded-full"
                onClick={onTogglePanel}
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                <ChevronDownIcon
                  aria-hidden="true"
                  className={cn(
                    "size-3.5 transition-transform duration-150",
                    panelOpen && "rotate-180",
                  )}
                />
              </Button>
            }
          />
          <TooltipPopup side="top">
            {panelOpen ? t("chat.hideThread") : t("chat.openThread")}
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
  const transcriptRef = useRef<HTMLDivElement>(null);
  const isFloating = layout === "floating";

  // Keep the newest message in view: jump to the bottom whenever the thread
  // grows (a sent prompt appends the user bubble + assistant placeholder).
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    }
  }, [messages.length]);

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
      aria-label={t("chat.aiThread")}
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
          aria-label={t("chat.resizeThread")}
          onPointerDown={handleResizeStart}
          onDoubleClick={() => onResize(null)}
          tabIndex={-1}
          className="group absolute inset-x-0 -top-3 z-20 flex h-3 cursor-ns-resize touch-none items-center justify-center select-none"
        >
          <div className="bg-foreground-subtle group-hover:bg-primary h-1 w-12 rounded-full transition-colors" />
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
        ref={transcriptRef}
        style={{ scrollbarGutter: "stable" }}
      >
        {messages.length === 0 && !isFloating ? (
          // Standalone empty state. Floating mode never reaches this
          // branch because the thread doesn't render until the first
          // message arrives; standalone always renders, so we need a
          // gentle landing surface instead of a blank canvas.
          <div className="text-foreground-strong-muted m-auto flex max-w-[28ch] flex-col items-center gap-1 text-center text-[12px] text-balance">
            <span className="text-foreground-strong-muted text-[13px] font-medium">
              {t("chat.emptyThreadTitle")}
            </span>
            <span>{t("chat.emptyThreadDescription")}</span>
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
  const t = useTranslations();
  const text =
    message.prompt.length > 0 ? message.prompt : t("chat.noPromptPresetOnly");
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
            {t("chat.pastedChars", {
              count: message.pastedText.length.toLocaleString(),
            })}
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
  const t = useTranslations();
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
            {t("chat.thinking")}
          </span>
        )}
        {message.status === "error" && (
          <span className="text-destructive text-[12px]">{message.error}</span>
        )}
        {message.text && message.text.length > 0 && (
          <MessageResponse className="text-[13px] leading-relaxed [&_p]:my-0">
            {message.text}
          </MessageResponse>
        )}
        {message.citations.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-muted-foreground text-[11px]">
              {t("chat.sources")}
            </span>
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
                  {t("chat.acceptAllCount", { count: String(pendingCount) })}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="rounded-md"
                  onClick={() => onRejectGroup(message.id)}
                >
                  {t("docxReview.rejectAll")}
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
  const t = useTranslations();
  const { citation, active, onActivate } = props;
  const sourceLabel =
    citation.source.kind === "pdf-bbox"
      ? t("chat.pageNumber", { page: String(citation.source.pageNumber) })
      : t("chat.inDocument");
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
            aria-label={t("chat.openCitation", { label: citation.label })}
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
  const t = useTranslations();
  const { suggestion, focused, showAcceptUI, onAccept, onReject, onFocus } =
    props;
  const { display } = suggestion;
  const isResolvable =
    suggestion.status === "pending" || suggestion.status === "stale";
  // For display-carrying (field) suggestions the rationale is often just
  // the field path again — the header and replacement row already show it.
  const showRationale =
    suggestion.rationale.length > 0 &&
    (!display || suggestion.rationale !== suggestion.topic);

  return (
    <div
      data-status={suggestion.status}
      className={cn(
        "border-border/60 bg-background/60 rounded-lg border px-3 py-2 transition-colors",
        focused && "border-foreground-disabled bg-muted/40",
      )}
    >
      <button
        type="button"
        className="text-muted-foreground flex w-full cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 text-start text-[11px]"
        onClick={() => onFocus(suggestion.id)}
        aria-label={t("chat.focusSuggestion", { topic: suggestion.topic })}
      >
        {display ? (
          <SuggestionDisplayBadges display={display} />
        ) : (
          <>
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                SEVERITY_DOT_CLASS[suggestion.severity],
              )}
              aria-hidden="true"
            />
            <span className="text-foreground font-medium">
              {suggestion.topic}
            </span>
            <span aria-hidden="true">·</span>
            <span>{t(SEVERITY_LABEL_KEYS[suggestion.severity])}</span>
          </>
        )}
        {suggestion.status === "stale" && (
          <span className="bg-destructive/12 text-destructive ms-1 inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium tracking-wider uppercase">
            {t("chat.suggestionStatus.stale")}
          </span>
        )}
        {suggestion.status === "accepted" && (
          <span className="bg-success/15 text-success ms-1 inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium tracking-wider uppercase">
            {t("chat.suggestionStatus.accepted")}
          </span>
        )}
        {suggestion.status === "rejected" && (
          <span className="bg-muted text-muted-foreground ms-1 inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium tracking-wider uppercase">
            {t("chat.suggestionStatus.rejected")}
          </span>
        )}
      </button>

      {display ? (
        <>
          <div className="bg-muted text-foreground mt-2 rounded-md px-2.5 py-1.5 text-[13px] leading-snug text-pretty break-words">
            <span className="decoration-foreground-ghost line-through">
              {suggestion.originalText}
            </span>
          </div>
          <div className="text-muted-foreground mt-1 px-2.5 font-mono text-[11px] leading-snug break-all">
            {suggestion.suggestedText}
          </div>
        </>
      ) : (
        <>
          <div className="bg-muted text-muted-foreground mt-2 flex flex-col gap-0.5 rounded-md px-2.5 py-1.5 text-[12.5px] leading-snug text-pretty break-words">
            <div className="flex gap-1.5">
              <span
                className="text-muted-foreground w-3 shrink-0 text-center tabular-nums"
                aria-hidden="true"
              >
                −
              </span>
              <span className="decoration-foreground-ghost line-through">
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
                  ? t("chat.removeSuggestion")
                  : suggestion.suggestedText}
              </span>
            </div>
          </div>
        </>
      )}

      {showRationale && (
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
            {t("common.accept")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="rounded-md"
            onClick={() => onReject(suggestion.id)}
          >
            {t("docxReview.reject")}
          </Button>
        </div>
      )}
    </div>
  );
}

type SuggestionDisplayBadgesProps = {
  display: NonNullable<AISuggestion["display"]>;
};

/** Header badges for display-carrying suggestions: the payload's value
 *  type plus who fills it (replaces the severity dot + label). */
function SuggestionDisplayBadges({ display }: SuggestionDisplayBadgesProps) {
  const t = useTranslations();
  return (
    <>
      {display.valueKind !== undefined && (
        <ValueKindChip valueKind={display.valueKind} />
      )}
      {display.filledBy === "ai" && (
        <span className="bg-info/10 text-info inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium">
          <WandSparklesIcon aria-hidden="true" className="size-3 shrink-0" />
          {t("templates.studio.draftedByAi")}
        </span>
      )}
      {display.filledBy === "person" && (
        <span className="bg-muted text-muted-foreground inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium">
          {t("templates.studio.filledByPerson")}
        </span>
      )}
    </>
  );
}

function ValueKindChip({ valueKind }: { valueKind: string }) {
  const t = useTranslations();
  if (!isValueTypeKind(valueKind)) {
    return null;
  }
  const meta = VALUE_TYPE_META[valueKind];
  const Icon = meta.icon;
  return (
    <span className="text-foreground inline-flex min-w-0 items-center gap-1 font-medium">
      <Icon aria-hidden="true" className="size-3.5 shrink-0 opacity-70" />
      <span className="truncate">{t(meta.labelKey)}</span>
    </span>
  );
}
