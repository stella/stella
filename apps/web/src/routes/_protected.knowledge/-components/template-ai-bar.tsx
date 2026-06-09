/**
 * Template Studio AI bar — mounts the shared file-AI chat host (floating
 * prompt bar + in-place suggestion decorations + the go-over-the-doc stepper)
 * over the Studio's Folio editor.
 *
 * Whatever the user types is treated as instructions for "suggest template
 * fields" (a preset prefills the generic ask): the model proposes which
 * literals become {{fields}}, and every occurrence of each literal renders as
 * an in-place suggestion to step through and accept/dismiss. Accepting wraps
 * that occurrence as the {{field}} marker and registers the field in the
 * Studio session.
 */

import { useMemo, useRef } from "react";

import type { EditorView } from "prosemirror-view";
import { useTranslations } from "use-intl";

import { buildPositionalText } from "@stll/folio";
import type { AISuggestion } from "@stll/folio";

import { FileAIChatHost } from "@/components/ai-suggestions/host";
import type {
  AIGenerateResponse,
  FileAIChatConfig,
} from "@/components/ai-suggestions/types";
import { useChatEditor } from "@/components/chat-editor-provider";
import { api } from "@/lib/api";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { createChatThreadId } from "@/lib/chat-thread-ref";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import { toAPIError } from "@/lib/errors";
import {
  type StudioField,
  useTemplateStudioStore,
} from "@/routes/_protected.knowledge/-components/template-studio-store";
import { isInputType } from "@/routes/_protected.knowledge/-components/template-wizard";

/** Chars of surrounding text recorded so suggestions survive document edits
 *  (the host re-anchors stale ranges via contextBefore/After). */
const CONTEXT_CHARS = 24;

const SUGGEST_FIELDS_PRESET_ID = "suggest-template-fields";

type SuggestedFieldMeta = Pick<
  StudioField,
  "path" | "inputType" | "aiPrompt" | "aiAdapt"
>;

type TemplateStudioAIBarProps = {
  editorView: EditorView | null;
  containerEl: HTMLElement | null;
  /** Read the page's live view ref — fresher than the reactive prop. */
  getView: () => EditorView | null;
  /** Force Folio's lazily created PM view (it defers until interaction). */
  ensureView: () => void;
};

export const TemplateStudioAIBar = ({
  editorView,
  containerEl,
  getView,
  ensureView,
}: TemplateStudioAIBarProps) => {
  const t = useTranslations();
  const user = useAuthenticatedUser();
  const upsertField = useTemplateStudioStore((s) => s.upsertField);
  const markDirty = useTemplateStudioStore((s) => s.markDirty);

  // Field metadata per suggestion id, consumed when the host reports an
  // applied suggestion (AISuggestion itself carries only text + range).
  const fieldMetaRef = useRef(new Map<string, SuggestedFieldMeta>());

  // The composer wants a thread identity for draft-keying; the Studio bar is
  // ephemeral (no persisted chat), so one synthetic global thread per mount.
  const threadId = useMemo(() => createChatThreadId(), []);
  const threadRef = useMemo<ChatThreadRef>(
    () => ({ scope: "global", threadId }),
    [threadId],
  );
  const editorController = useChatEditor({
    threadRef,
    placeholder: t("templates.studio.aiBarPlaceholder"),
  });

  const config = useMemo<FileAIChatConfig>(
    () => ({
      onGenerate: async (input): Promise<AIGenerateResponse> => {
        // Folio creates its PM view lazily; a submit straight after load (or
        // an HMR remount) can land before it exists. Ensure + retry a frame
        // later, and read the document from the view rather than trusting the
        // host's snapshot, so the first send never fails on an empty doc.
        let view = getView();
        if (!view) {
          ensureView();
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => resolve());
          });
          view = getView();
        }
        if (!view) {
          return { text: t("templates.studio.aiNoText") };
        }
        const bounds = input.selectionRange;
        const text = bounds
          ? input.selectionText
          : buildPositionalText(view.state.doc).text;
        if (text.trim().length === 0) {
          return { text: t("templates.studio.aiNoText") };
        }
        // The preset asks for field suggestions; anything typed freely is a
        // general edit instruction ("change the governing law to Czech") and
        // goes to the edit generator instead.
        if (input.presetId === SUGGEST_FIELDS_PRESET_ID) {
          const response = await api.templates["suggest-fields"].post({
            text,
          });
          if (response.error) {
            throw toAPIError(response.error);
          }
          const suggestions = buildFieldSuggestions(
            view,
            response.data.suggestions,
            bounds,
            fieldMetaRef.current,
          );
          if (suggestions.length === 0) {
            return { text: t("templates.studio.aiNoFields") };
          }
          return {
            text: t("templates.studio.aiFoundFields", {
              count: suggestions.length,
            }),
            suggestions,
          };
        }

        const instruction = input.prompt.trim();
        if (instruction.length === 0) {
          return { text: t("templates.studio.aiNoText") };
        }
        const response = await api.templates["suggest-edits"].post({
          text,
          instruction,
        });
        if (response.error) {
          throw toAPIError(response.error);
        }
        const suggestions = buildEditSuggestions(
          view,
          response.data.edits,
          bounds,
        );
        if (suggestions.length === 0) {
          return { text: t("templates.studio.aiNoEdits") };
        }
        return {
          text: t("templates.studio.aiFoundEdits", {
            count: suggestions.length,
          }),
          suggestions,
        };
      },
      presets: [
        {
          id: SUGGEST_FIELDS_PRESET_ID,
          label: t("templates.studio.aiSuggest"),
          prompt: t("templates.studio.aiPresetPrompt"),
          mode: "edit",
        },
      ],
      inputPlaceholder: t("templates.studio.aiBarPlaceholder"),
      defaultMode: "edit",
      defaultApplyMode: "direct",
      promptForApplyMode: false,
      onSuggestionApplied: (suggestion) => {
        const meta = fieldMetaRef.current.get(suggestion.id);
        if (!meta) {
          return;
        }
        upsertField(meta.path, {
          inputType: meta.inputType,
          aiPrompt: meta.aiPrompt,
          aiAdapt: meta.aiAdapt,
        });
        markDirty();
      },
    }),
    [t, upsertField, markDirty, getView, ensureView],
  );

  return (
    <FileAIChatHost
      authorFallback={user.preferredName ?? user.name ?? user.email}
      config={config}
      containerEl={containerEl}
      editorController={editorController}
      editorView={editorView}
      layout="floating"
      readOnly={false}
    />
  );
};

/**
 * Shared occurrence mapper: turn (literal -> replacement) specs into in-place
 * document suggestions, one AISuggestion per occurrence of each literal
 * (inside the requested bounds). Occurrences and their context windows come
 * from the same positional-text model the staleness resolver searches
 * (`buildPositionalText`, blocks joined with \n) — contexts built any other
 * way fail to re-anchor after the first edit and the suggestions all go
 * stale. One suggestion per span: first spec wins per occupied range.
 */
type ReplacementSpec = {
  literalText: string;
  suggestedText: string;
  topic: string;
  rationale: string;
  /** Badges describing the suggestion's payload (field flow only). */
  display?: AISuggestion["display"];
  /** Registers field metadata for this suggestion id (field flow only). */
  registerMeta?: (id: string) => void;
};

const buildReplacementSuggestions = (
  view: EditorView,
  specs: readonly ReplacementSpec[],
  bounds: { from: number; to: number } | null,
): AISuggestion[] => {
  const { doc } = view.state;
  const positional = buildPositionalText(doc);
  const haystack = positional.text;
  const suggestions: AISuggestion[] = [];
  const occupied: { from: number; to: number }[] = [];

  for (const spec of specs) {
    if (spec.literalText.length === 0) {
      continue;
    }
    let idx = haystack.indexOf(spec.literalText);
    while (idx !== -1) {
      const from = positional.pmPositionAt(idx);
      const to = positional.pmPositionAt(idx + spec.literalText.length - 1) + 1;
      const overlaps = occupied.some((r) => from < r.to && to > r.from);
      if (!overlaps && (!bounds || (from >= bounds.from && to <= bounds.to))) {
        occupied.push({ from, to });
        const id = crypto.randomUUID();
        spec.registerMeta?.(id);
        const suggestion: AISuggestion = {
          id,
          topic: spec.topic,
          severity: "substantive",
          range: { from, to },
          originalText: spec.literalText,
          suggestedText: spec.suggestedText,
          contextBefore: haystack.slice(Math.max(0, idx - CONTEXT_CHARS), idx),
          contextAfter: haystack.slice(
            idx + spec.literalText.length,
            idx + spec.literalText.length + CONTEXT_CHARS,
          ),
          rationale: spec.rationale,
          status: "pending",
        };
        if (spec.display !== undefined) {
          suggestion.display = spec.display;
        }
        suggestions.push(suggestion);
      }
      idx = haystack.indexOf(spec.literalText, idx + spec.literalText.length);
    }
  }

  return suggestions.toSorted((a, b) => a.range.from - b.range.from);
};

/** Mirrors the Studio inspector's who-fills derivation: aiAdapt wins
 *  (person writes a stub, AI adapts it), then a drafting prompt, else
 *  a person fills the value directly. */
const filledByForMeta = (
  meta: SuggestedFieldMeta,
): NonNullable<NonNullable<AISuggestion["display"]>["filledBy"]> => {
  if (meta.aiAdapt) {
    return "personAi";
  }
  if (meta.aiPrompt !== undefined) {
    return "ai";
  }
  return "person";
};

/** Field flow: each literal becomes its `{{field}}` marker; collision-free
 *  path decided at generation time so every occurrence shares one marker. */
const buildFieldSuggestions = (
  view: EditorView,
  suggested: readonly {
    literalText: string;
    fieldPath: string;
    inputType?: string | undefined;
    aiPrompt?: string | undefined;
    aiAdapt?: boolean | undefined;
  }[],
  bounds: { from: number; to: number } | null,
  fieldMeta: Map<string, SuggestedFieldMeta>,
): AISuggestion[] => {
  const existing = useTemplateStudioStore.getState().fields;
  const takenPaths = new Set(existing.map((f) => f.path));
  const specs: ReplacementSpec[] = [];

  for (const item of suggested) {
    let path = item.fieldPath;
    for (let n = 2; takenPaths.has(path); n++) {
      path = `${item.fieldPath}_${n}`;
    }
    takenPaths.add(path);
    const meta: SuggestedFieldMeta = {
      path,
      inputType:
        item.inputType !== undefined && isInputType(item.inputType)
          ? item.inputType
          : "text",
      aiPrompt: item.aiPrompt,
      aiAdapt: item.aiAdapt === true,
    };
    specs.push({
      literalText: item.literalText,
      suggestedText: `{{${path}}}`,
      topic: path,
      rationale: path,
      display: {
        valueKind: meta.inputType,
        filledBy: filledByForMeta(meta),
      },
      registerMeta: (id) => {
        fieldMeta.set(id, meta);
      },
    });
  }

  return buildReplacementSuggestions(view, specs, bounds);
};

/** Edit flow: free-form instruction results, applied verbatim. */
const buildEditSuggestions = (
  view: EditorView,
  edits: readonly {
    originalText: string;
    replacementText: string;
    note?: string | undefined;
  }[],
  bounds: { from: number; to: number } | null,
): AISuggestion[] =>
  buildReplacementSuggestions(
    view,
    edits.map((edit) => ({
      literalText: edit.originalText,
      suggestedText: edit.replacementText,
      topic: edit.note ?? edit.replacementText,
      rationale: edit.note ?? "",
    })),
    bounds,
  );
