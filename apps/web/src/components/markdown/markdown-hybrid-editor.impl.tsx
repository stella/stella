import { useRef, useState } from "react";

import {
  EditorController,
  EditorModel,
  EditorView,
  LocalHistoryStrategy,
  StringValue,
} from "@vscode/markdown-editor";
import { autorun } from "@vscode/observables";
// The editor takes keyboard input through the EditContext API, which WebKit and
// Gecko do not ship yet. The polyfill installs itself only when the API is
// missing, so Chromium keeps the native path.
import "@neftaly/editcontext-polyfill";
import { useDebouncedCallback } from "use-debounce";
import { useTranslations } from "use-intl";

import { cn } from "@stll/ui/utils";

import "@vscode/markdown-editor/editor.css";
import "@vscode/markdown-editor/themes/vscode-default.css";
import "katex/dist/katex.min.css";

import "./markdown-hybrid-editor.css";

import { useExternalSyncEffect, useMountEffect } from "@/hooks/use-effect";
import { openIsolatedWindow } from "@/lib/open-isolated-window";

// Coalesce keystrokes before emitting upward: hosts persist on every change.
const EMIT_DELAY_MS = 400;

export type MarkdownHybridEditorProps = {
  /** The markdown to edit. Read once per mount; the editor owns its state after
   * that (the host keys the component per file to force a reload on switch). */
  markdown: string;
  /** Fired (debounced) with the current markdown on every edit. */
  onMarkdownChange: (markdown: string) => void;
  readOnly?: boolean;
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
  const emit = useDebouncedCallback(onMarkdownChange, EMIT_DELAY_MS);

  useMountEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
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
    // Seeded content must not read as an edit; only later changes emit.
    let lastEmitted = model.sourceText.get().value;
    const subscription = autorun((reader) => {
      const text = model.sourceText.read(reader).value;
      if (text === lastEmitted) {
        return;
      }
      lastEmitted = text;
      emit(text);
    });
    return () => {
      // A pending debounced edit would otherwise be lost on tab switch.
      emit.flush();
      subscription.dispose();
      controller.dispose();
      view.dispose();
      view.element.remove();
    };
  });

  useExternalSyncEffect(() => {
    model.readonlyMode.set(readOnly, undefined);
  }, [model, readOnly]);

  return (
    <div
      aria-label={t("markdownEditor.rawLabel")}
      className={cn(
        "markdown-hybrid-editor min-h-0 flex-1 overflow-y-auto",
        className,
      )}
      ref={hostRef}
      role="region"
    />
  );
};
