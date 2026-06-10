/**
 * Template Studio chat — the general document chat engine (same
 * backend, composer, tool surface, and persistence as the DOCX file
 * overlay) mounted over the Studio's Folio editor.
 *
 * Differences from the file overlay:
 *   - context is `activeTemplate` (org-scoped template, no entity);
 *   - the model gets `suggest_template_fields` plus the general tools;
 *   - approved `apply-active-docx-edits` operations land as in-document
 *     AISuggestions (decorations + stepper + cards) instead of the
 *     inspector review panel. Accepting a `{{field}}` replacement also
 *     registers the field in the Studio session.
 */

import {
  Suspense,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { RefObject } from "react";

import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { Result } from "better-result";
import { LoaderCircleIcon } from "lucide-react";
import type { EditorView } from "prosemirror-view";
import { useTranslations } from "use-intl";

import {
  applySuggestions,
  resolveSuggestionAnchor,
  setAISuggestionsMeta,
  setFocusedSuggestionMeta,
} from "@stll/folio";
import type {
  AISuggestion,
  AISuggestionPreset,
  DocxEditorRef,
  FolioAIEditSnapshot,
} from "@stll/folio";
import { Button } from "@stll/ui/components/button";
import { stellaToast } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";

import {
  PromptBar,
  scrollEditorToPos,
  SuggestionCard,
  SuggestionStepper,
} from "@/components/ai-suggestions/host";
import type { PromptBarPresetScope } from "@/components/ai-suggestions/host";
import { useChatEditor } from "@/components/chat-editor-provider";
import { ChatApprovalContext } from "@/components/chat/chat-approval-context";
import { ChatMattersContext } from "@/components/chat/chat-matters-context";
import { ChatThreadMessages } from "@/components/chat/chat-thread-messages";
import { getActiveDocxEditApprovalPart } from "@/components/chat/chat-ui-tools";
import type {
  ApprovalToolName,
  PersistedChatMessage,
} from "@/components/chat/chat-ui-tools";
import { useAIKeyGate } from "@/components/require-ai-key";
import { getAnalytics } from "@/lib/analytics/provider";
import { ChatAnonymizationLayer } from "@/lib/anonymize/use-chat-anonymization-layer";
import { api } from "@/lib/api";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { toChatThreadId } from "@/lib/chat-thread-ref";
import type { ChatThreadId, ChatThreadRef } from "@/lib/chat-thread-ref";
import { useDevStore } from "@/lib/dev-store";
import { toAPIError } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";
import { inputTypeValueKind } from "@/lib/value-types";
import { useChatSession } from "@/routes/_protected.chat/-hooks/use-chat-session";
import { useChatUserContext } from "@/routes/_protected.chat/-hooks/use-chat-user-context";
import {
  chatKeys,
  chatThreadOptions,
  SUGGEST_TEMPLATE_FIELDS_TOOL_SCOPE,
  templateChatThreadOptions,
} from "@/routes/_protected.chat/-queries";
import type {
  ApplyActiveDocxEditsInput,
  ApplyActiveDocxEditsOutput,
} from "@/routes/_protected.chat/-queries";
import { useTemplateStudioStore } from "@/routes/_protected.knowledge/-components/template-studio-store";
import {
  buildOperationSpecs,
  buildReplacementSuggestions,
  extractFieldMarkerPath,
  filledByForFieldMeta,
  operationSpecId,
} from "@/routes/_protected.knowledge/-components/template-studio-suggestions";
import type {
  BuildReplaceSpecArgs,
  ReplacementSpec,
  SuggestedFieldMeta,
} from "@/routes/_protected.knowledge/-components/template-studio-suggestions";
import { isInputType } from "@/routes/_protected.knowledge/-components/template-wizard";

const SUGGEST_FIELDS_PRESET_ID = "suggest-template-fields";

const protectedRouteApi = getRouteApi("/_protected");

type TemplateStudioChatProps = {
  templateId: string;
  /** Template DOCX file name — context label for the model + placeholder. */
  fileName: string;
  editorRef: RefObject<DocxEditorRef | null>;
  /** Reactive live PM view (Folio creates it lazily and re-reports). */
  editorView: EditorView | null;
  /** Read the page's live view ref — fresher than the reactive prop. */
  getView: () => EditorView | null;
  /** Force Folio's lazily created PM view (it defers until interaction). */
  ensureView: () => void;
};

export const TemplateStudioChat = (props: TemplateStudioChatProps) => (
  <Suspense
    fallback={
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-8 flex justify-center"
      >
        <LoaderCircleIcon className="text-muted-foreground size-4 animate-spin" />
      </div>
    }
  >
    <ResolvedTemplateStudioChat {...props} />
  </Suspense>
);

/**
 * Resolves the per-template thread mapping (org + user scoped,
 * server-side) so reopening a template resumes its latest thread,
 * mirroring how .docx file tabs resolve theirs via `file-thread`.
 */
/**
 * A scoped preset send waiting for its fresh thread. The rotate
 * remounts the inner surface (key change); the new instance picks
 * this up on mount and dispatches it with the named tool scope, so
 * the preset turn always starts a clean thread and the backend
 * restricts it to the suggest-template-fields allowlist.
 */
type ScopedPresetSend = {
  text: string;
};

const ResolvedTemplateStudioChat = (props: TemplateStudioChatProps) => {
  const t = useTranslations();
  const activeOrganizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const queryClient = useQueryClient();
  const { data: chatThreadId } = useSuspenseQuery(
    templateChatThreadOptions({
      activeOrganizationId,
      key: { templateId: props.templateId },
    }),
  );
  const [pendingPresetSend, setPendingPresetSend] =
    useState<ScopedPresetSend | null>(null);

  // "New chat" rotates the server-side mapping to a fresh thread and
  // swaps the cached id; the key change remounts the inner surface
  // (which also drops the previous thread's in-document suggestions).
  const rotateThread = async (): Promise<boolean> => {
    const rotated = await Result.tryPromise(
      async () =>
        await api.chat["template-thread"].rotate.post({
          templateId: toSafeId<"template">(props.templateId),
        }),
    );
    if (Result.isError(rotated)) {
      getAnalytics().captureError(rotated.error);
      stellaToast.add({ title: t("common.somethingWentWrong"), type: "error" });
      return false;
    }
    const { data, error } = rotated.value;
    if (error) {
      getAnalytics().captureError(toAPIError(error));
      stellaToast.add({ title: t("common.somethingWentWrong"), type: "error" });
      return false;
    }
    queryClient.setQueryData(
      chatKeys.templateThread(activeOrganizationId, {
        templateId: props.templateId,
      }),
      toChatThreadId(data.threadId),
    );
    return true;
  };

  // Scoped preset: rotate first so the turn ALWAYS starts a fresh
  // thread, then hand the send to the remounted inner instance. The
  // cache swap and the pending-send state land in the same commit,
  // so only the new instance ever sees the request.
  const handleScopedPresetSend = async (request: ScopedPresetSend) => {
    const rotated = await rotateThread();
    if (rotated) {
      setPendingPresetSend(request);
    }
  };

  return (
    <TemplateStudioChatInner
      key={chatThreadId}
      chatThreadId={chatThreadId}
      onNewThread={() => {
        void rotateThread();
      }}
      onScopedPresetSend={(request) => {
        void handleScopedPresetSend(request);
      }}
      pendingPresetSend={pendingPresetSend}
      onPendingPresetSendHandled={() => {
        setPendingPresetSend(null);
      }}
      {...props}
    />
  );
};

type TemplateStudioChatInnerProps = TemplateStudioChatProps & {
  chatThreadId: ChatThreadId;
  onNewThread: () => void;
  onScopedPresetSend: (request: ScopedPresetSend) => void;
  pendingPresetSend: ScopedPresetSend | null;
  onPendingPresetSendHandled: () => void;
};

const TemplateStudioChatInner = ({
  templateId,
  fileName,
  editorRef,
  editorView,
  getView,
  ensureView,
  chatThreadId,
  onNewThread,
  onScopedPresetSend,
  pendingPresetSend,
  onPendingPresetSendHandled,
}: TemplateStudioChatInnerProps) => {
  const t = useTranslations();
  const user = useAuthenticatedUser();
  const author = user.preferredName ?? user.name ?? user.email;
  const activeOrganizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const userContext = useChatUserContext();
  const getUserContext = useEffectEvent(() => userContext);
  const showToolCallDetails = useDevStore((s) => s.showToolCallDetails);
  const upsertField = useTemplateStudioStore((s) => s.upsertField);
  const markDirty = useTemplateStudioStore((s) => s.markDirty);

  // ---- editor readiness gate ------------------------------------------------
  // Folio's PM view exists almost immediately, but there is a window
  // where `createAIEditSnapshot()` still returns null. A send in that
  // window gives the model no editable blocks. Poll until the first
  // non-null snapshot, then stop (mirrors the file overlay).
  const [editorReady, setEditorReady] = useState(() =>
    Boolean(editorRef.current?.createAIEditSnapshot()),
  );
  useEffect(() => {
    if (editorReady) {
      return undefined;
    }
    ensureView();
    const probe = () => {
      if (editorRef.current?.createAIEditSnapshot()) {
        setEditorReady(true);
        return true;
      }
      return false;
    };
    if (probe()) {
      return undefined;
    }
    const id = window.setInterval(() => {
      ensureView();
      if (probe()) {
        window.clearInterval(id);
      }
    }, 80);
    // Never gate the input forever; `canSubmitNow` re-checks the
    // snapshot at submit time anyway.
    const fallback = window.setTimeout(() => {
      window.clearInterval(id);
      setEditorReady(true);
    }, 3000);
    return () => {
      window.clearInterval(id);
      window.clearTimeout(fallback);
    };
  }, [editorReady, editorRef, ensureView]);

  // ---- per-turn template context --------------------------------------------

  /** Snapshot most recently sent to the model — its block ids are the
   *  ones tool operations reference, so op→text resolution reads it. */
  const lastSentSnapshotRef = useRef<FolioAIEditSnapshot | null>(null);
  const getActiveTemplate = useEffectEvent(() => {
    const snapshot = editorRef.current?.createAIEditSnapshot() ?? null;
    lastSentSnapshotRef.current = snapshot;
    return {
      templateId,
      fileName,
      ...(snapshot === null
        ? {}
        : { docxEditSnapshot: { blocks: snapshot.blocks } }),
    };
  });

  // ---- in-document suggestions ----------------------------------------------

  const [suggestions, setSuggestions] = useState<AISuggestion[]>([]);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  // Field metadata per suggestion id, consumed on accept (AISuggestion
  // itself carries only text + range + display badges).
  const fieldMetaRef = useRef(new Map<string, SuggestedFieldMeta>());
  // Accept side-effects per suggestion id (bilingual-mirror flow).
  const mirrorAcceptRef = useRef(new Map<string, () => void>());

  // The page queues bilingual-mirror proposals through the store; this
  // surface places them because it is the Studio's only suggestion
  // decoration writer (a second writer would clobber the decorations).
  const pendingMirrorRequests = useTemplateStudioStore(
    (s) => s.pendingMirrorRequests,
  );
  const clearMirrorRequests = useTemplateStudioStore(
    (s) => s.clearMirrorRequests,
  );
  useEffect(() => {
    if (pendingMirrorRequests.length === 0) {
      return;
    }
    const view = getView() ?? editorView;
    if (!view) {
      // Keep the queue; the effect re-runs once the live view arrives.
      return;
    }
    const specs = pendingMirrorRequests.map(({ spec, onAccepted }) => ({
      ...spec,
      registerMeta: (suggestionId: string) => {
        spec.registerMeta?.(suggestionId);
        if (onAccepted) {
          mirrorAcceptRef.current.set(suggestionId, onAccepted);
        }
      },
    }));
    const { suggestions: created } = buildReplacementSuggestions(
      view.state.doc,
      specs,
    );
    if (created.length > 0) {
      setSuggestions((prev) => [...prev, ...created]);
    }
    clearMirrorRequests();
  }, [pendingMirrorRequests, editorView, getView, clearMirrorRequests]);

  // Push suggestion decorations into the live editor. This surface is
  // the only decoration writer in the Studio, so empty pushes (after
  // the last accept/dismiss) are safe and required for clearing.
  useEffect(() => {
    if (!editorView) {
      return;
    }
    const meta = setAISuggestionsMeta(suggestions);
    editorView.dispatch(editorView.state.tr.setMeta(meta.key, meta.payload));
  }, [editorView, suggestions]);

  useEffect(() => {
    if (!editorView) {
      return;
    }
    const meta = setFocusedSuggestionMeta(focusedId);
    editorView.dispatch(editorView.state.tr.setMeta(meta.key, meta.payload));
  }, [editorView, focusedId]);

  // Clear this thread's decorations when the surface unmounts (leaving
  // the Studio or swapping to a new thread).
  const getViewForCleanup = useEffectEvent(() => getView());
  useEffect(
    () => () => {
      const view = getViewForCleanup();
      if (!view || view.isDestroyed) {
        return;
      }
      const meta = setAISuggestionsMeta([]);
      view.dispatch(view.state.tr.setMeta(meta.key, meta.payload));
    },
    [],
  );

  // ---- accept / dismiss -------------------------------------------------------

  const registerAcceptedField = (suggestionId: string) => {
    const meta = fieldMetaRef.current.get(suggestionId);
    if (!meta) {
      return;
    }
    const exists = useTemplateStudioStore
      .getState()
      .fields.some((field) => field.path === meta.path);
    // A reused path means the field is already configured; don't
    // clobber its settings with the tool's proposal.
    upsertField(
      meta.path,
      exists
        ? {}
        : {
            inputType:
              meta.inputType !== undefined && isInputType(meta.inputType)
                ? meta.inputType
                : "text",
            ...(meta.label === undefined ? {} : { label: meta.label }),
            ...(meta.aiPrompt === undefined ? {} : { aiPrompt: meta.aiPrompt }),
          },
    );
  };

  const applyTargets = (targets: AISuggestion[]) => {
    const view = getView();
    if (!view || targets.length === 0) {
      return;
    }
    const result = applySuggestions({
      view,
      suggestions: targets,
      mode: "direct",
      author,
    });
    setSuggestions((prev) =>
      prev.map((s) => {
        if (result.applied.includes(s.id)) {
          return { ...s, status: "accepted" };
        }
        if (result.stale.includes(s.id)) {
          return { ...s, status: "stale" };
        }
        return s;
      }),
    );
    for (const id of result.applied) {
      registerAcceptedField(id);
      mirrorAcceptRef.current.get(id)?.();
    }
    if (result.applied.length > 0) {
      markDirty();
    }
  };

  const acceptOne = (suggestionId: string) => {
    const target = suggestions.find(
      (s) => s.id === suggestionId && s.status === "pending",
    );
    if (target) {
      applyTargets([target]);
    }
  };

  const rejectOne = (suggestionId: string) => {
    setSuggestions((prev) =>
      prev.map((s) =>
        s.id === suggestionId && s.status === "pending"
          ? { ...s, status: "rejected" }
          : s,
      ),
    );
  };

  const acceptAllPending = () => {
    applyTargets(suggestions.filter((s) => s.status === "pending"));
  };

  const rejectAllPending = () => {
    setSuggestions((prev) =>
      prev.map((s) =>
        s.status === "pending" ? { ...s, status: "rejected" } : s,
      ),
    );
  };

  // ---- focus + stepper --------------------------------------------------------

  const focusSuggestion = (suggestionId: string) => {
    setFocusedId(suggestionId);
    const view = getView();
    const target = suggestions.find((s) => s.id === suggestionId);
    if (!view || !target) {
      return;
    }
    const anchor = resolveSuggestionAnchor(view.state.doc, target);
    if (anchor) {
      scrollEditorToPos(view, anchor.from);
    }
  };
  const focusSuggestionEvent = useEffectEvent(focusSuggestion);

  const orderedPending = useMemo(
    () =>
      suggestions
        .filter((s) => s.status === "pending")
        .toSorted((a, b) => a.range.from - b.range.from),
    [suggestions],
  );
  const focusedPendingIndex = focusedId
    ? orderedPending.findIndex((s) => s.id === focusedId)
    : -1;
  const stepperIndex = focusedPendingIndex === -1 ? 0 : focusedPendingIndex;

  const stepBy = (delta: number) => {
    if (orderedPending.length === 0) {
      return;
    }
    const target = orderedPending.at(
      (stepperIndex + delta + orderedPending.length) % orderedPending.length,
    );
    if (target) {
      focusSuggestion(target.id);
    }
  };

  // Accept/dismiss the focused suggestion and advance to the next pending
  // one (the one after it in document order, else the previous).
  const resolveCurrent = (action: "accept" | "dismiss") => {
    const current = orderedPending.at(stepperIndex);
    if (!current) {
      return;
    }
    const next =
      orderedPending.at(stepperIndex + 1) ??
      (stepperIndex > 0 ? orderedPending.at(stepperIndex - 1) : undefined);
    if (action === "accept") {
      acceptOne(current.id);
    } else {
      rejectOne(current.id);
    }
    if (next) {
      focusSuggestion(next.id);
    } else {
      setFocusedId(null);
    }
  };

  // When a tool call lands new suggestions, jump to the first fresh one
  // so the in-document review starts immediately.
  const seenSuggestionIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const seen = seenSuggestionIdsRef.current;
    const fresh = orderedPending.find((s) => !seen.has(s.id));
    for (const s of orderedPending) {
      seen.add(s.id);
    }
    if (fresh) {
      focusSuggestionEvent(fresh.id);
    }
  }, [orderedPending]);

  // ---- chat session -----------------------------------------------------------

  const threadRef = useMemo<ChatThreadRef>(
    () => ({ scope: "global", threadId: chatThreadId }),
    [chatThreadId],
  );

  // No `handleActiveDocxEditToolCall` in the context: the transport
  // never invokes it (the approve path below client-executes the tool),
  // and `getActiveTemplate` already keys the cache as "active-template".
  const { data } = useSuspenseQuery(
    chatThreadOptions({
      activeOrganizationId,
      key: threadRef,
      context: {
        allowMissingThread: true,
        getUserContext,
        getActiveTemplate: () => getActiveTemplate(),
      },
    }),
  );
  const { chat } = data;

  const {
    error,
    messages,
    resendLatestMessage,
    sendMessage,
    queuedMessages,
    removeQueuedMessage,
    stop,
    isGenerating,
    alwaysApprovedTools,
    conversationApprovedTools,
    handleApprove,
    handleAllowInConversation,
    handleDeny,
    handleAskUserSubmit,
    handleAskUserEditAndRerun,
    handleAlwaysAllow,
    handleCreateDocumentResolve,
    handleOpenCreatedDocument,
    createDocumentMatters,
    isLoadingCreateDocumentMatters,
    addToolOutput,
    streamdownComponents,
    approvalPendingMessageId,
  } = useChatSession({ chat, conversationId: threadRef.threadId });
  const { ensureAIAvailable, openIfAIUnavailable } = useAIKeyGate();

  useEffect(() => {
    openIfAIUnavailable();
  }, [openIfAIUnavailable]);

  // Dispatch a scoped preset send queued by the rotate flow: this
  // instance mounts already bound to the fresh thread, so the send
  // lands there. The named tool scope rides the request body and the
  // backend narrows the turn's tools to the suggest-template-fields
  // allowlist. The local ref de-duplicates StrictMode's double
  // effect invocation, which runs before the parent can commit the
  // cleared pending-send state.
  const presetSendDispatchedRef = useRef(false);
  const dispatchPendingPresetSend = useEffectEvent(() => {
    const request = pendingPresetSend;
    if (request === null || presetSendDispatchedRef.current) {
      return;
    }
    presetSendDispatchedRef.current = true;
    onPendingPresetSendHandled();
    void ensureAIAvailable().then((available) => {
      if (!available) {
        return;
      }
      // This send bypasses the prompt bar's `canSubmitNow` (which
      // normally records the sent snapshot), and after the rotate
      // remount the transport's `getActiveTemplate` can be bound to a
      // previous instance whose ref this one cannot see. Record the
      // snapshot here so the apply path resolves the ops against the
      // same blocks the model receives.
      lastSentSnapshotRef.current =
        editorRef.current?.createAIEditSnapshot() ?? null;
      setPanelOpen(true);
      void sendMessage(
        { text: request.text },
        { body: { toolScope: SUGGEST_TEMPLATE_FIELDS_TOOL_SCOPE } },
      );
      return;
    });
  });
  useEffect(() => {
    dispatchPendingPresetSend();
  }, []);

  /**
   * Scoped "Suggest fields" preset submit. For the selection scope
   * the selected text is appended to the preset prompt so the model
   * confines its proposals to that part; the document snapshot still
   * rides along as context for anchoring the edits.
   */
  const submitScopedPreset = (
    preset: AISuggestionPreset,
    scope: PromptBarPresetScope,
  ) => {
    let text = preset.prompt;
    if (scope === "selection") {
      const view = getView();
      const selectionText =
        view !== null && !view.state.selection.empty
          ? view.state.doc
              .textBetween(
                view.state.selection.from,
                view.state.selection.to,
                "\n",
                "\n",
              )
              .trim()
          : "";
      if (selectionText.length > 0) {
        text = `${preset.prompt}\n\n${t("templates.studio.aiScopeSelectionPrompt")}\n${selectionText}`;
      }
    }
    onScopedPresetSend({ text });
  };

  const editorController = useChatEditor({
    placeholder: t("chat.editableFilePlaceholder", { fileName }),
    threadRef,
  });

  // ---- tool execution ----------------------------------------------------------

  /**
   * Block text by id for op→spec resolution. The snapshot most
   * recently sent to the model wins (the ops' `find`/scope texts were
   * written against it); a fresh snapshot fills the gaps. Block ids
   * are paraId-derived and stable across snapshots, so ops survive a
   * remount (dev HMR, the rotate flow's suspense retry) that left
   * `lastSentSnapshotRef` empty or bound to another instance.
   */
  const collectOperationBlockTexts = (): Map<string, string> => {
    const blockTextById = new Map<string, string>();
    const freshSnapshot = editorRef.current?.createAIEditSnapshot() ?? null;
    for (const block of freshSnapshot?.blocks ?? []) {
      blockTextById.set(block.id, block.text);
    }
    for (const block of lastSentSnapshotRef.current?.blocks ?? []) {
      blockTextById.set(block.id, block.text);
    }
    return blockTextById;
  };

  /**
   * Client executor for `apply-active-docx-edits`: convert the approved
   * operations into in-document AISuggestions anchored via positional
   * text, and report queued/skipped ids back to the model.
   */
  const handleActiveDocxEditToolCall = useEffectEvent(
    (input: ApplyActiveDocxEditsInput): ApplyActiveDocxEditsOutput => {
      let view = getView();
      if (!view) {
        ensureView();
        view = getView();
      }
      if (!view) {
        return {
          applied: [],
          queued: [],
          skipped: input.operations.map((operation, index) => ({
            id: operationSpecId(operation, index),
            reason: "documentNotEditable",
          })),
        };
      }

      const fieldMetaByPath = collectSuggestedFieldMeta(messages);
      const { specs, skipped } = buildOperationSpecs({
        operations: input.operations,
        blockTextById: collectOperationBlockTexts(),
        buildReplaceSpec: (args) =>
          buildSpecForReplace({
            ...args,
            fieldMetaByPath,
            fieldMeta: fieldMetaRef.current,
          }),
      });

      const { suggestions: created, placedSpecIds } =
        buildReplacementSuggestions(view.state.doc, specs);
      for (const spec of specs) {
        if (!placedSpecIds.has(spec.id)) {
          skipped.push({ id: spec.id, reason: "missingFind" });
        }
      }
      if (created.length > 0) {
        setSuggestions((prev) => [...prev, ...created]);
      }

      return {
        applied: [],
        queued: [...placedSpecIds].map((id) => ({ id })),
        skipped,
      };
    },
  );

  // Approving an apply-active-docx-edits call client-executes it: the
  // operations become in-document suggestions and the queued/skipped
  // summary goes back to the model via addToolOutput. (The approval
  // card auto-approves DOCX edit batches; review happens per
  // suggestion in the document.)
  const handleApproveForTemplate = async (
    approvalId: string,
    toolName: ApprovalToolName,
  ) => {
    if (toolName === "apply-active-docx-edits") {
      const part = getActiveDocxEditApprovalPart(messages, approvalId);
      if (!part) {
        handleApprove(approvalId, toolName);
        return;
      }
      handleApprove(approvalId, toolName);
      const output = handleActiveDocxEditToolCall(part.input);
      await addToolOutput({
        output,
        tool: "apply-active-docx-edits",
        toolCallId: part.toolCallId,
      });
      return;
    }

    handleApprove(approvalId, toolName);
  };

  const canSubmitWithCurrentSnapshot = useEffectEvent(() => {
    const snapshot = editorRef.current?.createAIEditSnapshot() ?? null;
    if (snapshot) {
      lastSentSnapshotRef.current = snapshot;
      return true;
    }
    lastSentSnapshotRef.current = null;
    setEditorReady(false);
    return false;
  });

  // ---- render -------------------------------------------------------------------

  const threadScrollRef = useRef<HTMLDivElement>(null);
  const hasMessages = messages.length > 0;
  const hasThreadContent = hasMessages || error !== undefined;
  const lastMessageId = messages.at(-1)?.id ?? null;
  // Auto-open the thread panel as soon as the first message lands so
  // users see streaming without having to click the chevron.
  useEffect(() => {
    if (hasThreadContent) {
      setPanelOpen(true);
    }
  }, [hasThreadContent]);
  useLayoutEffect(() => {
    const scrollElement = threadScrollRef.current;
    if (!scrollElement) {
      return;
    }
    scrollElement.scrollTo({
      behavior: "instant",
      top: scrollElement.scrollHeight,
    });
  }, [isGenerating, lastMessageId]);

  const pendingCount = orderedPending.length;
  const threadVisible = panelOpen && hasThreadContent;

  return (
    <ChatMattersContext
      value={{ createDocumentMatters, isLoadingCreateDocumentMatters }}
    >
      <ChatApprovalContext
        value={{
          activeOrganizationId,
          alwaysApprovedTools,
          conversationApprovedTools,
          handleAllowInConversation,
          handleAlwaysAllow,
          handleApprove: handleApproveForTemplate,
          handleDeny,
        }}
      >
        {threadVisible && (
          <div
            aria-label={t("chat.aiThread")}
            className={cn(
              "absolute start-1/2 bottom-[88px] z-40 flex max-h-[min(45dvh,380px)] min-h-0 w-[min(560px,calc(100%-2rem))] -translate-x-1/2 flex-col overflow-hidden rounded-2xl border",
              "bg-popover/90 border-border text-popover-foreground",
              "[backdrop-filter:blur(18px)_saturate(160%)] [-webkit-backdrop-filter:blur(18px)_saturate(160%)]",
              "before:bg-foreground/[0.06] before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:h-px",
              "hover:bg-popover focus-within:bg-popover",
              "transition-[background-color,border-color] duration-200 ease-out",
              "shadow-[0_1px_2px_rgb(0_0_0/0.06),0_20px_64px_rgb(0_0_0/0.18)]",
              "animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-1",
            )}
            role="dialog"
          >
            <div
              ref={threadScrollRef}
              className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3"
              style={{ scrollbarGutter: "stable" }}
            >
              <ChatThreadMessages
                approvalPendingMessageId={approvalPendingMessageId}
                error={error}
                isGenerating={isGenerating}
                messages={messages}
                onAskUserEditAndRerun={handleAskUserEditAndRerun}
                onAskUserSubmit={handleAskUserSubmit}
                onCreateDocumentResolve={handleCreateDocumentResolve}
                onOpenCreatedDocument={handleOpenCreatedDocument}
                onRemoveQueuedMessage={removeQueuedMessage}
                onResend={resendLatestMessage}
                queuedMessages={queuedMessages}
                showThinkingIndicator
                showToolCallDetails={showToolCallDetails}
                streamdownComponents={streamdownComponents}
              />
              {suggestions.length > 0 && (
                <div className="flex flex-col gap-2">
                  {pendingCount > 1 && (
                    <div className="flex items-center gap-1.5">
                      <Button
                        className="rounded-md"
                        onClick={acceptAllPending}
                        size="xs"
                        type="button"
                        variant="ghost"
                      >
                        {t("chat.acceptAllCount", {
                          count: String(pendingCount),
                        })}
                      </Button>
                      <Button
                        className="rounded-md"
                        onClick={rejectAllPending}
                        size="xs"
                        type="button"
                        variant="ghost"
                      >
                        {t("docxReview.rejectAll")}
                      </Button>
                    </div>
                  )}
                  {suggestions.map((suggestion) => (
                    <SuggestionCard
                      focused={focusedId === suggestion.id}
                      key={suggestion.id}
                      onAccept={acceptOne}
                      onFocus={focusSuggestion}
                      onReject={rejectOne}
                      showAcceptUI
                      suggestion={suggestion}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {!threadVisible && pendingCount > 0 && (
          <SuggestionStepper
            index={stepperIndex}
            onAccept={() => resolveCurrent("accept")}
            onDismiss={() => resolveCurrent("dismiss")}
            onStep={stepBy}
            total={pendingCount}
          />
        )}

        <ChatAnonymizationLayer
          editor={editorController.editor}
          enabled={false}
          workspaceId={threadRef.threadId}
        />
        <PromptBar
          canSubmitNow={canSubmitWithCurrentSnapshot}
          editorController={editorController}
          emptyPlaceholder={
            <span className="text-foreground-ghost flex min-w-0 items-center gap-1.5 text-[13px] leading-5">
              <span className="shrink-0">
                {t("chat.editableFilePlaceholderAction")}
              </span>
              <span className="text-foreground-label max-w-64 truncate">
                {fileName}
              </span>
            </span>
          }
          layout="floating"
          newThreadLabel={t("chat.newChat")}
          onNewThread={() => {
            // Abort any live stream first: the rotation remount only
            // swaps the surface, while the old Chat instance would
            // keep streaming inside the query cache.
            void stop();
            setPanelOpen(false);
            onNewThread();
          }}
          onStop={() => {
            void stop();
          }}
          onSubmit={({ prompt }) => {
            void ensureAIAvailable().then((available) => {
              if (!available) {
                return;
              }
              // Always pop the thread open on send, even if the user
              // minimised it earlier.
              setPanelOpen(true);
              void sendMessage({ text: prompt });
              return;
            });
          }}
          onTogglePanel={() => setPanelOpen((v) => !v)}
          panelOpen={panelOpen}
          pendingCount={pendingCount}
          presetScopeChooser={{
            appliesTo: (preset) => preset.id === SUGGEST_FIELDS_PRESET_ID,
            shouldAskForScope: () =>
              useTemplateStudioStore.getState().ui.hasSelection,
            question: t("templates.studio.aiScopeQuestion"),
            selectionLabel: t("templates.studio.aiScopeSelection"),
            documentLabel: t("templates.studio.aiScopeDocument"),
            onSubmit: submitScopedPreset,
          }}
          presets={[
            {
              id: SUGGEST_FIELDS_PRESET_ID,
              label: t("templates.studio.aiSuggest"),
              prompt: t("templates.studio.aiPresetPrompt"),
              mode: "edit",
            },
          ]}
          queueWhileGenerating
          sendDisabledReason={editorReady ? undefined : "editor-loading"}
          showThreadToggle={hasThreadContent}
          status={isGenerating ? "generating" : "idle"}
          threadHasMessages={hasMessages}
        />
      </ChatApprovalContext>
    </ChatMattersContext>
  );
};

// ---------------------------------------------------------------------------
// Tool-operation → spec helpers
// ---------------------------------------------------------------------------

/**
 * Field metadata by path, joined from every `suggest_template_fields`
 * output in the thread (later outputs win). Lets an
 * `apply-active-docx-edits` replacement whose `replace` is a
 * `{{field.path}}` marker recover the proposed input type / AI prompt.
 */
const collectSuggestedFieldMeta = (
  messages: PersistedChatMessage[],
): Map<string, SuggestedFieldMeta> => {
  const byPath = new Map<string, SuggestedFieldMeta>();
  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }
    for (const part of message.parts) {
      if (
        part.type !== "tool-suggest_template_fields" ||
        part.state !== "output-available"
      ) {
        continue;
      }
      for (const suggested of part.output.suggestions) {
        byPath.set(suggested.fieldPath, {
          path: suggested.fieldPath,
          inputType: suggested.inputType,
          label: suggested.label,
          aiPrompt: suggested.aiPrompt,
        });
      }
    }
  }
  return byPath;
};

type BuildSpecForReplaceOptions = BuildReplaceSpecArgs & {
  fieldMetaByPath: Map<string, SuggestedFieldMeta>;
  /** Sink for per-suggestion field metadata, consumed on accept. */
  fieldMeta: Map<string, SuggestedFieldMeta>;
};

/**
 * One replacement spec. When the replacement is a single `{{path}}`
 * marker, the spec carries the field-proposal display badges
 * (valueKind + who fills it) and registers metadata so accepting the
 * suggestion also registers the field in the Studio session.
 */
const buildSpecForReplace = ({
  id,
  find,
  replace,
  scopeText,
  comment,
  area,
  fieldMetaByPath,
  fieldMeta,
}: BuildSpecForReplaceOptions): ReplacementSpec => {
  const path = extractFieldMarkerPath(replace);
  if (path === null) {
    return {
      id,
      literalText: find,
      suggestedText: replace,
      topic: comment ?? area,
      rationale: comment ?? "",
      ...(scopeText === undefined ? {} : { scopeText }),
    };
  }

  const meta = fieldMetaByPath.get(path) ?? { path };
  const inputType =
    meta.inputType !== undefined && isInputType(meta.inputType)
      ? meta.inputType
      : "text";
  return {
    id,
    literalText: find,
    suggestedText: replace,
    topic: path,
    rationale: path,
    ...(scopeText === undefined ? {} : { scopeText }),
    display: {
      valueKind: inputTypeValueKind(inputType),
      filledBy: filledByForFieldMeta(meta),
    },
    registerMeta: (suggestionId) => {
      fieldMeta.set(suggestionId, meta);
    },
  };
};
