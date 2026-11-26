import { useImperativeHandle, useRef, useState } from "react";
import type { Ref } from "react";

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
import { createEffect, observableValue } from "@vscode/observables";
import { panic } from "better-result";
// The editor takes keyboard input through the EditContext API, which WebKit and
// Gecko do not ship yet. The polyfill installs itself only when the API is
// missing, so Chromium keeps the native path.
import "@neftaly/editcontext-polyfill";
import { useDebouncedCallback } from "use-debounce";

import { useExternalSyncEffect } from "@stll/ui/effects";
import { useLatest } from "@stll/ui/use-latest";
import { cn } from "@stll/ui/utils";

import "@vscode/markdown-editor/editor.css";
import "@vscode/markdown-editor/themes/vscode-default.css";
import "@vscode/markdown-editor/commentWidget.css";
import "@vscode/markdown-editor/commentInput.css";
import "katex/dist/katex.min.css";

import "./markdown-hybrid-editor.css";

// Coalesce keystrokes before emitting upward: hosts persist on every change.
const EMIT_DELAY_MS = 400;

const NO_COMMENTS: readonly MarkdownEditorComment[] = [];

/** Strips every rendered `<img>` under `root` whose source the host refuses. */
const enforceImagePolicy = (
  root: HTMLElement,
  allowsImageSource: (src: string | null) => boolean,
) => {
  for (const img of root.querySelectorAll("img")) {
    if (!allowsImageSource(img.getAttribute("src"))) {
      img.removeAttribute("src");
    }
  }
};

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

export type MarkdownHybridEditorHandle = {
  /** Flush the current source and lock input before publication begins. */
  captureForSave: () => string;
  /** Replace the source without allowing a pending edit to reappear later. */
  resetMarkdown: (markdown: string) => void;
};

export type MarkdownHybridEditorProps = {
  ref?: Ref<MarkdownHybridEditorHandle> | undefined;
  /** The markdown to edit. Read once per mount; the editor owns its state after
   * that (the host keys the component per file to force a reload on switch). */
  markdown: string;
  /** Fired with the current markdown on every edit; debounced by default. */
  onMarkdownChange: (markdown: string) => void;
  /** The editor region's accessible name, in the member's language. */
  label: string;
  /**
   * Opens a link the user activates. The host decides how, or that links do
   * not open at all: left to itself, the engine would navigate to any url the
   * document names.
   */
  onOpenLink: (url: string) => void;
  /** Manual-save hosts need immediate changes for unsaved-work guards. */
  changeEmission?: "debounced" | "immediate";
  /**
   * Which image sources the rendered (inactive) blocks may fetch; any other
   * source is stripped, so opening a document cannot trigger an outbound
   * request driven by its content. Every host decides explicitly.
   *
   * Decided at mount, like `markdown`: the engine builds image elements
   * directly from source urls with no per-render hook, so this is enforced by
   * watching the mounted DOM rather than by filtering source text. A host
   * that needs a different policy must remount with a different `key`.
   */
  allowsImageSource: (src: string | null) => boolean;
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
    ((input: { start: number; end: number; text: string }) => void) | undefined;
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
 * concerns (skill frontmatter, workspace file persistence) live in the host,
 * and so does what only the host can decide: the editor's label, how a link
 * opens and which images may load.
 */
export const MarkdownHybridEditor = ({
  ref,
  markdown,
  onMarkdownChange,
  label,
  onOpenLink,
  changeEmission = "debounced",
  allowsImageSource,
  readOnly = false,
  baseline,
  comments = NO_COMMENTS,
  onAddComment,
  onDeleteComment,
  className,
}: MarkdownHybridEditorProps) => {
  const hostRef = useRef<HTMLDivElement>(null);
  // The model is a plain object, so it can be created during render; the view
  // and controller touch the DOM and are created on mount.
  const [model] = useState(() => {
    const created = new EditorModel();
    created.replaceSourceText(new StringValue(markdown));
    return created;
  });
  const [commentsModel] = useState(() => new CommentsModel());
  const [hostReadOnly] = useState(() =>
    observableValue("markdown host read-only", readOnly),
  );
  // The ids this host last pushed into `commentsModel`. A deletion the user
  // performs in a comment widget mutates the model directly, so the difference
  // between this set and the model's current ids is exactly "removed in the
  // editor" — and because a host push updates the latch *before* writing the
  // model, a host-driven removal can never be mistaken for a user one and
  // echoed back.
  const pushedCommentIds = useRef<ReadonlySet<string>>(new Set());
  const emit = useDebouncedCallback(onMarkdownChange, EMIT_DELAY_MS);
  // The engine and its subscriptions outlive the render that created them, so
  // they call the host's latest callbacks through these refs.
  const publishChange = useLatest((text: string) => {
    switch (changeEmission) {
      case "debounced":
        emit(text);
        return;
      case "immediate":
        onMarkdownChange(text);
        return;
      default:
        changeEmission satisfies never;
        panic("Unhandled markdown change emission mode");
    }
  });
  const addComment = useLatest(
    (input: { start: number; end: number; text: string }) => {
      onAddComment?.(input);
    },
  );
  const deleteComment = useLatest((id: string) => {
    onDeleteComment?.(id);
  });
  const openLink = useLatest(onOpenLink);
  // Decided at mount, like `markdown`: a host that changes the image policy or
  // toggles comment mode remounts the editor with a new `key`.
  const [mountChoices] = useState(() => ({
    allowsImageSource,
    commentMode: readOnly && onAddComment !== undefined,
  }));
  useImperativeHandle(ref, () => ({
    captureForSave: () => {
      hostReadOnly.set(true, undefined);
      model.readonlyMode.set(true, undefined);
      emit.flush();
      return model.sourceText.get().value;
    },
    resetMarkdown: (nextMarkdown) => {
      emit.cancel();
      model.replaceSourceText(new StringValue(nextMarkdown));
      // Replacing the model notifies its subscription synchronously, which
      // schedules a new emission. Reset publishes immediately instead.
      emit.cancel();
      onMarkdownChange(nextMarkdown);
    },
  }));

  // Set up once per mount: every dependency below keeps its identity for the
  // editor's life, and the engine owns its state after the seed. Later values
  // reach the engine through the latest-value refs above and the sync effects
  // below.
  useExternalSyncEffect(() => {
    const { allowsImageSource: allowsSource, commentMode } = mountChoices;
    const host = hostRef.current;
    if (!host) {
      panic("markdown editor host is not mounted");
    }
    const view = new EditorView(model, {
      classNames: ["md-theme-vscode-default", "md-theme-stella"],
      // The host owns permissions and publication locking.
      showReadonlyToggle: false,
      onOpenLink: (url) => {
        openLink.current(url);
      },
      onToggleCheckbox: (item, checked) => {
        model.setTaskCheckboxChecked(item, checked);
      },
    });
    // The engine builds each image element's `src` straight from the source url
    // and exposes no render hook to intercept it, so a source outside the policy
    // is cleared off the DOM instead. Timing is what makes that effective: the
    // constructor assigns those urls synchronously, and the browser only starts
    // an image request at the microtask checkpoint after the current task, so
    // clearing the attribute in this same task means no request is issued. The
    // pass runs on the constructed element and again after the append, covering
    // content the engine renders at either point; the observer then covers every
    // later block (re)render.
    //
    // Filtering the markdown text instead would be simpler but wrong here: this
    // is an editor, and the filtered text is what the model would emit on the
    // next keystroke, so the document would silently lose image destinations the
    // user never touched.
    enforceImagePolicy(view.element, allowsSource);
    const imageObserver = new MutationObserver(() => {
      enforceImagePolicy(host, allowsSource);
    });
    imageObserver.observe(host, {
      attributeFilter: ["src"],
      childList: true,
      subtree: true,
    });
    host.append(view.element);
    enforceImagePolicy(host, allowsSource);
    const controller = new EditorController(model, view, {
      historyStrategy: new LocalHistoryStrategy(model),
    });
    const readonlySubscription = createEffect((reader) => {
      if (hostReadOnly.read(reader) && !model.readonlyMode.read(reader)) {
        // Engine commands may toggle its mode; a host lock is authoritative.
        model.readonlyMode.set(true, undefined);
      }
    });
    const commentsView = new CommentsView(commentsModel, view);
    // The engine only shows the affordance in read-only mode, so mounting it
    // outside a review view would be dead weight.
    const commentModeController = commentMode
      ? new CommentModeController(model, view, {
          onSubmit: ({ range, text }) => {
            addComment.current({
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
        publishChange.current(text);
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
          deleteComment.current(id);
        }
      }
    });
    return () => {
      // A pending debounced edit would otherwise be lost on tab switch.
      emit.flush();
      imageObserver.disconnect();
      commentsSubscription.dispose();
      subscription.dispose();
      readonlySubscription.dispose();
      commentModeController?.dispose();
      commentsView.dispose();
      controller.dispose();
      view.dispose();
      view.element.remove();
    };
  }, [
    addComment,
    commentsModel,
    deleteComment,
    emit,
    hostReadOnly,
    model,
    mountChoices,
    openLink,
    publishChange,
  ]);

  // Pushes the host's lock into the engine whenever it changes.
  useExternalSyncEffect(() => {
    hostReadOnly.set(readOnly, undefined);
    model.readonlyMode.set(readOnly, undefined);
  }, [hostReadOnly, model, readOnly]);

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
      aria-label={label}
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
