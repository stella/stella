import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { CodeIcon, PenLineIcon } from "lucide-react";
import { useDebouncedCallback } from "use-debounce";
import { useTranslations } from "use-intl";

import "@stll/folio/editor.css";
import { DocxEditor, fromMarkdown, toMarkdown } from "@stll/folio";
import type { Document, DocxEditorRef, MarkdownOptions } from "@stll/folio";
import { Button } from "@stll/ui/components/button";
import { Textarea } from "@stll/ui/components/textarea";
import { cn } from "@stll/ui/lib/utils";

import { useDocxFitZoom } from "@/components/docx-preview-zoom";

// Flatten Word constructs markdown can't carry so the emitted markdown stays
// clean: drop comments/annotations, flatten tracked changes, inline links,
// strip footnotes.
const CLEAN_MARKDOWN: MarkdownOptions = {
  annotations: "strip",
  trackedChanges: "clean",
  comments: "strip",
  hyperlinks: "inline",
  footnotes: "strip",
};

// Serialising the whole document on every keystroke is wasteful; coalesce edits
// before emitting upward.
const EMIT_DELAY_MS = 400;

export type MarkdownFolioEditorProps = {
  /** The markdown to edit. Read once per mount; the editor owns its state after
   * that (the host keys the component per file to force a reload on switch). */
  markdown: string;
  /** Fired (debounced) with the current markdown on every edit, in either mode. */
  onMarkdownChange: (markdown: string) => void;
  readOnly?: boolean;
  className?: string;
};

/**
 * A markdown editor that defaults to the Folio WYSIWYG surface (so non-technical
 * users never see raw markdown) with a "Show raw" escape hatch to a plain text
 * area for power users. Review chrome (track changes, markup views) is hidden —
 * markdown has no such concepts — and zoom stays available.
 *
 * Generic: it edits a plain markdown string and emits changes. Domain-specific
 * concerns (skill frontmatter / guide callouts, workspace file persistence) live
 * in the host, which transforms `markdown` on the way in and persists on the way
 * out.
 */
export function MarkdownFolioEditor({
  markdown,
  onMarkdownChange,
  readOnly = false,
  className,
}: MarkdownFolioEditorProps) {
  const t = useTranslations();
  // Latest content across both modes — the bridge when toggling raw ⇄ WYSIWYG.
  const currentRef = useRef(markdown);
  const [mode, setMode] = useState<"wysiwyg" | "raw">("wysiwyg");
  // Seeds the Folio document; bumped when (re)entering WYSIWYG so the editor
  // reloads from the latest markdown after a raw edit.
  const [seed, setSeed] = useState(markdown);
  const [rawText, setRawText] = useState(markdown);

  const doc = useMemo<Document>(() => fromMarkdown(seed), [seed]);
  // The editor's normalized form of the current seed. Folio fires an onChange
  // right after it parses/lays out the document; comparing against this baseline
  // keeps that load-time change (and any no-op edit) from emitting upward, so the
  // host doesn't see the file as dirty the moment it opens.
  const baseline = useMemo(() => toMarkdown(doc, CLEAN_MARKDOWN), [doc]);
  const lastEmittedRef = useRef(baseline);
  useEffect(() => {
    lastEmittedRef.current = baseline;
  }, [baseline]);

  const emit = useDebouncedCallback(onMarkdownChange, EMIT_DELAY_MS);

  const emitIfChanged = (md: string) => {
    currentRef.current = md;
    if (md === lastEmittedRef.current) {
      return;
    }
    lastEmittedRef.current = md;
    emit(md);
  };

  const onFolioChange = (next: Document) => {
    emitIfChanged(toMarkdown(next, CLEAN_MARKDOWN));
  };

  const onRawChange = (text: string) => {
    setRawText(text);
    emitIfChanged(text);
  };

  const showRaw = () => {
    setRawText(currentRef.current);
    setMode("raw");
  };

  const showFormatted = () => {
    setSeed(currentRef.current);
    setMode("wysiwyg");
  };

  // Fit the page to the panel width with the same hook the DOCX inspector uses,
  // so markdown fills the inspector (body text full-width) and re-fits on resize
  // — identical behaviour to editing a .docx.
  const editorRef = useRef<DocxEditorRef>(null);
  // Same fit params as the DOCX inspector (max auto-zoom 0.85) so markdown sits
  // identically — page fits the panel with margins, no clipped text.
  const { containerRef: fitZoomRef, fitZoom } = useDocxFitZoom(0, 0.85);
  useLayoutEffect(() => {
    editorRef.current?.setZoom(fitZoom);
  }, [fitZoom]);

  if (mode === "raw") {
    return (
      <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
        <ModeBar
          icon={<PenLineIcon className="size-3.5" />}
          label={t("markdownEditor.showFormatted")}
          onClick={showFormatted}
        />
        <Textarea
          aria-label={t("markdownEditor.rawLabel")}
          className="min-h-0 flex-1 resize-none rounded-none border-0 font-mono text-xs focus-visible:ring-0"
          onChange={(event) => onRawChange(event.currentTarget.value)}
          readOnly={readOnly}
          value={rawText}
        />
      </div>
    );
  }

  return (
    <div
      className={cn("flex min-h-0 flex-1 flex-col", className)}
      ref={fitZoomRef}
    >
      <DocxEditor
        className="h-full"
        document={doc}
        initialZoom={fitZoom}
        key={seed}
        mode={readOnly ? "viewing" : "editing"}
        onChange={onFolioChange}
        ref={editorRef}
        showPrintButton={false}
        showReviewControls={false}
        showZoomControl
        toolbarExtra={
          <ModeButton
            icon={<CodeIcon className="size-3.5" />}
            label={t("markdownEditor.showRaw")}
            onClick={showRaw}
          />
        }
      />
    </div>
  );
}

type ModeControlProps = {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
};

const ModeButton = ({ icon, label, onClick }: ModeControlProps) => (
  <Button
    onClick={onClick}
    onMouseDown={(event) => event.preventDefault()}
    size="xs"
    type="button"
    variant="ghost"
  >
    {icon}
    <span className="whitespace-nowrap">{label}</span>
  </Button>
);

const ModeBar = ({ icon, label, onClick }: ModeControlProps) => (
  <div className="border-border flex shrink-0 items-center justify-end border-b px-2 py-1">
    <ModeButton icon={icon} label={label} onClick={onClick} />
  </div>
);
