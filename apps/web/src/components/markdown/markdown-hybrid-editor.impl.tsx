import { useRef, useState } from "react";

import {
  CommentModeController,
  CommentsModel,
  CommentsView,
  EditorController,
  EditorModel,
  EditorView,
  LocalHistoryStrategy,
  OffsetRange,
  StringValue,
} from "@vscode/markdown-editor";
import { createEffect } from "@vscode/observables";
import { panic } from "better-result";
// The editor takes keyboard input through the EditContext API, which WebKit and
// Gecko do not ship yet. The polyfill installs itself only when the API is
// missing, so Chromium keeps the native path.
import "@neftaly/editcontext-polyfill";
import { useDebouncedCallback } from "use-debounce";
import { useTranslations } from "use-intl";

import { cn } from "@stll/ui/utils";

import "@vscode/markdown-editor/editor.css";
import "@vscode/markdown-editor/themes/vscode-default.css";
import "@vscode/markdown-editor/commentWidget.css";
import "@vscode/markdown-editor/commentInput.css";
import "katex/dist/katex.min.css";

import "./markdown-hybrid-editor.css";

import { useExternalSyncEffect, useMountEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { openIsolatedWindow } from "@/lib/open-isolated-window";

// Coalesce keystrokes before emitting upward: hosts persist on every change.
const EMIT_DELAY_MS = 400;

const NO_COMMENTS: readonly MarkdownEditorComment[] = [];

/** A comment the host owns, anchored to a range of {@link MarkdownHybridEditorProps.markdown}. */
export type MarkdownEditorComment = {
  id: string;
  /** Inclusive start offset into the editor markdown. */
  start: number;
  /** Exclusive end offset into the editor markdown. */
  end: number;
  body: string;
  author?: string | undefined;
};

export type MarkdownHybridEditorProps = {
  /** The markdown to edit. Read once per mount; the editor owns its state after
   * that (the host keys the component per file to force a reload on switch). */
  markdown: string;
  /** Fired (debounced) with the current markdown on every edit. */
  onMarkdownChange: (markdown: string) => void;
  readOnly?: boolean;
  /**
   * Text to diff against. Setting it puts the editor in diff mode: `markdown`
   * stays the editable document while the baseline's removed and changed blocks
   * render as read-only decorations. Clearing it returns to plain rendering.
   */
  baseline?: string | undefined;
  /** Comments to display beside their ranges. Mirrored into the editor on change. */
  comments?: readonly MarkdownEditorComment[] | undefined;
  /**
   * Enables the "add comment" affordance for a non-empty selection. Only
   * mounted while `readOnly` is also set — the engine's comment mode is a
   * review-view feature. Decided at mount, like `markdown`: a host that toggles
   * comment mode must remount the editor with a different `key`.
   */
  onAddComment?:
    | ((input: { start: number; end: number; text: string }) => void)
    | undefined;
  /** Fired when the user removes a comment through its widget. */
  onDeleteComment?: ((id: string) => void) | undefined;
  className?: string;
};

/**
 * Hybrid markdown editor: the raw markdown string is the single source of
 * truth, blocks that touch the selection show their syntax markers, every other
 * block renders formatted. There is no lossy round-trip through a rich-text
 * document model, so frontmatter, HTML comments, and unusual constructs survive
 * editing byte-for-byte.
 *
 * Generic: it edits a plain markdown string and emits changes. Domain-specific
 * concerns (skill frontmatter, workspace file persistence) live in the host.
 */
export const MarkdownHybridEditor = ({
  markdown,
  onMarkdownChange,
  readOnly = false,
  baseline,
  comments = NO_COMMENTS,
  onAddComment,
  onDeleteComment,
  className,
}: MarkdownHybridEditorProps) => {
  const t = useTranslations();
  const hostRef = useRef<HTMLDivElement>(null);
  // The model is a plain object, so it can be created during render; the view
  // and controller touch the DOM and are created on mount.
  const [model] = useState(() => {
    const created = new EditorModel();
    created.replaceSourceText(new StringValue(markdown));
    return created;
  });
  const [commentsModel] = useState(() => new CommentsModel());
  // The ids this host last pushed into `commentsModel`. A deletion the user
  // performs in a comment widget mutates the model directly, so the difference
  // between this set and the model's current ids is exactly "removed in the
  // editor" — and because a host push updates the latch *before* writing the
  // model, a host-driven removal can never be mistaken for a user one and
  // echoed back.
  const pushedCommentIds = useRef<ReadonlySet<string>>(new Set());
  const emit = useDebouncedCallback(onMarkdownChange, EMIT_DELAY_MS);
  const addComment = useLatestCallback(
    (input: { start: number; end: number; text: string }) => {
      onAddComment?.(input);
    },
  );
  const deleteComment = useLatestCallback((id: string) => {
    onDeleteComment?.(id);
  });

  useMountEffect(() => {
    const host = hostRef.current;
    if (!host) {
      panic("markdown editor host is not mounted");
    }
    const view = new EditorView(model, {
      classNames: ["md-theme-vscode-default", "md-theme-stella"],
      onOpenLink: (url) => {
        openIsolatedWindow(url);
      },
      onToggleCheckbox: (item, checked) => {
        model.setTaskCheckboxChecked(item, checked);
      },
    });
    host.append(view.element);
    const controller = new EditorController(model, view, {
      historyStrategy: new LocalHistoryStrategy(model),
    });
    const commentsView = new CommentsView(commentsModel, view);
    // The engine only shows the affordance in read-only mode, so mounting it
    // outside a review view would be dead weight.
    const commentModeController =
      readOnly && onAddComment
        ? new CommentModeController(model, view, {
            onSubmit: ({ range, text }) => {
              addComment({
                start: range.start,
                end: range.endExclusive,
                text,
              });
            },
          })
        : undefined;
    // Seeded content must not read as an edit; only later changes emit.
    let lastEmitted = model.sourceText.get().value;
    const subscription = createEffect((reader) => {
      const text = model.sourceText.read(reader).value;
      if (text !== lastEmitted) {
        lastEmitted = text;
        emit(text);
      }
    });
    const commentsSubscription = createEffect((reader) => {
      const present = new Set(
        commentsModel.comments.read(reader).map((comment) => comment.id),
      );
      const removed = [...pushedCommentIds.current].filter(
        (id) => !present.has(id),
      );
      if (removed.length > 0) {
        pushedCommentIds.current = present;
        for (const id of removed) {
          deleteComment(id);
        }
      }
    });
    return () => {
      // A pending debounced edit would otherwise be lost on tab switch.
      emit.flush();
      commentsSubscription.dispose();
      subscription.dispose();
      commentModeController?.dispose();
      commentsView.dispose();
      controller.dispose();
      view.dispose();
      view.element.remove();
    };
  });

  useExternalSyncEffect(() => {
    model.readonlyMode.set(readOnly, undefined);
  }, [model, readOnly]);

  useExternalSyncEffect(() => {
    model.baseline.set(
      baseline === undefined ? undefined : new StringValue(baseline),
      undefined,
    );
  }, [model, baseline]);

  useExternalSyncEffect(() => {
    pushedCommentIds.current = new Set(comments.map((comment) => comment.id));
    commentsModel.set(
      comments.map((comment) => ({
        id: comment.id,
        range: OffsetRange.fromTo(comment.start, comment.end),
        body: comment.body,
        ...(comment.author === undefined ? {} : { author: comment.author }),
      })),
    );
  }, [commentsModel, comments]);

  return (
    <div
      aria-label={t("markdownEditor.rawLabel")}
      // Markdown source is a left-to-right document even under an RTL locale:
      // syntax markers, caret movement, and block layout must not mirror.
      dir="ltr"
      className={cn(
        "markdown-hybrid-editor min-h-0 flex-1 overflow-y-auto",
        className,
      )}
      ref={hostRef}
      role="region"
    />
  );
};
