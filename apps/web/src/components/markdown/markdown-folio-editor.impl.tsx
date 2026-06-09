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

import {
  DOCX_PAGE_WIDTH,
  useDocxFitZoom,
  useDocxWheelZoom,
} from "@/components/docx-preview-zoom";
import { composeRefs } from "@/lib/slot";

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

// Fit the whole page (not the ~624px text area, which would push the page's side
// margins off the right edge) so it sits centred with breathing space on each side.
// Inflating the fit target by the gutter reserves ~7.5% of the panel width as a
// margin per side: DOCX_PAGE_WIDTH / (1 - 2 × 0.075) = 960.
const PAGE_SIDE_GUTTER = 0.075;
const PAGE_FIT_WIDTH = DOCX_PAGE_WIDTH / (1 - 2 * PAGE_SIDE_GUTTER);

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

  // Reuse the DOCX inspector's fit-to-width + ctrl/⌘-wheel pinch zoom, but fit the
  // whole page rather than the text area: fitting the text area pushes the page's
  // side margins off the right edge, whereas fitting the page (PAGE_FIT_WIDTH bakes
  // in a gutter allowance) centres it with breathing space on each side and re-fits
  // on resize. composeRefs merges the wheel-zoom container ref with the fit hook's
  // callback ref onto one element.
  const editorRef = useRef<DocxEditorRef>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const { containerRef: fitZoomRef, fitZoom } = useDocxFitZoom({
    maxAutoZoom: 1,
    fitWidth: PAGE_FIT_WIDTH,
  });
  const composedContainerRef = useMemo(
    () => composeRefs(containerRef, fitZoomRef),
    [fitZoomRef],
  );
  useLayoutEffect(() => {
    editorRef.current?.setZoom(fitZoom);
  }, [fitZoom]);
  useDocxWheelZoom(containerRef, editorRef);

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
      ref={composedContainerRef}
    >
      <DocxEditor
        className="h-full"
        document={doc}
        initialZoom={fitZoom}
        key={seed}
        mode={readOnly ? "viewing" : "editing"}
        onChange={onFolioChange}
        ref={editorRef}
        showHeaderFooterEditing={false}
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
