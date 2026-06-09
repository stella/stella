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

type SuggestedFieldMeta = Pick<StudioField, "path" | "inputType" | "aiPrompt">;

type TemplateStudioAIBarProps = {
  editorView: EditorView | null;
  containerEl: HTMLElement | null;
};

export const TemplateStudioAIBar = ({
  editorView,
  containerEl,
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

  const editorViewRef = useRef<EditorView | null>(null);
  editorViewRef.current = editorView;

  const config = useMemo<FileAIChatConfig>(
    () => ({
      onGenerate: async (input): Promise<AIGenerateResponse> => {
        const view = editorViewRef.current;
        if (!view) {
          return { text: t("templates.studio.aiNoText") };
        }
        const bounds = input.selectionRange;
        const text = bounds ? input.selectionText : input.documentText;
        if (text.trim().length === 0) {
          return { text: t("templates.studio.aiNoText") };
        }
        const instructions = input.prompt.trim();
        const response = await api.templates["suggest-fields"].post({
          text,
          ...(instructions ? { instructions } : {}),
        });
        if (response.error) {
          throw toAPIError(response.error);
        }
        const suggestions = buildSuggestions(
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
      },
      presets: [
        {
          id: "suggest-template-fields",
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
        });
        markDirty();
      },
    }),
    [t, upsertField, markDirty],
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
 * Map the model's field suggestions onto in-place document suggestions: one
 * AISuggestion per occurrence of each literal (single text node, inside the
 * requested bounds), replacing the literal with its `{{field}}` marker.
 * Records each suggestion's field metadata for registration on accept.
 */
const buildSuggestions = (
  view: EditorView,
  suggested: readonly {
    literalText: string;
    fieldPath: string;
    inputType?: string | undefined;
    aiPrompt?: string | undefined;
  }[],
  bounds: { from: number; to: number } | null,
  fieldMeta: Map<string, SuggestedFieldMeta>,
): AISuggestion[] => {
  const { doc } = view.state;
  const existing = useTemplateStudioStore.getState().fields;
  const takenPaths = new Set(existing.map((f) => f.path));
  const suggestions: AISuggestion[] = [];

  for (const item of suggested) {
    if (item.literalText.length === 0) {
      continue;
    }
    // Collision-free path decided at generation time so every occurrence of
    // this literal carries the same marker text.
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
    };

    doc.descendants((node, pos) => {
      if (!node.isText || !node.text) {
        return true;
      }
      let idx = node.text.indexOf(item.literalText);
      while (idx !== -1) {
        const from = pos + idx;
        const to = from + item.literalText.length;
        if (!bounds || (from >= bounds.from && to <= bounds.to)) {
          const id = crypto.randomUUID();
          fieldMeta.set(id, meta);
          suggestions.push({
            id,
            topic: path,
            severity: "substantive",
            range: { from, to },
            originalText: item.literalText,
            suggestedText: `{{${path}}}`,
            contextBefore: doc.textBetween(
              Math.max(0, from - CONTEXT_CHARS),
              from,
              " ",
            ),
            contextAfter: doc.textBetween(
              to,
              Math.min(doc.content.size, to + CONTEXT_CHARS),
              " ",
            ),
            rationale: path,
            status: "pending",
          });
        }
        idx = node.text.indexOf(
          item.literalText,
          idx + item.literalText.length,
        );
      }
      return true;
    });
  }

  return suggestions.toSorted((a, b) => a.range.from - b.range.from);
};
