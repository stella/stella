import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import {
  BracesIcon,
  EyeIcon,
  EyeOffIcon,
  PlusIcon,
  RepeatIcon,
  SaveIcon,
  SplitIcon,
} from "lucide-react";
import type { EditorView } from "prosemirror-view";
import { useTranslations } from "use-intl";

import type { DocxEditorRef } from "@stll/folio";
import { Button } from "@stll/ui/components/button";
import { Input } from "@stll/ui/components/input";
import {
  Popover,
  PopoverPopup,
  PopoverTrigger,
} from "@stll/ui/components/popover";
import { stellaToast } from "@stll/ui/components/toast";
import "@stll/folio/editor.css";

import { api } from "@/lib/api";
import { DOCX_MIME } from "@/lib/consts";
import { toSafeId } from "@/lib/safe-id";
import {
  knowledgeKeys,
  templateDocxBufferOptions,
} from "@/routes/_protected.knowledge/-queries";

const DocxEditor = lazy(async () => {
  const m = await import("@stll/folio");
  return { default: m.DocxEditor };
});

const protectedRouteApi = getRouteApi("/_protected");

/**
 * Full-fidelity, editable view of a template's source .docx, rendered by the
 * in-house Folio editor (no collaboration session). Edits are saved explicitly
 * as a new template version; Folio preserves the embedded manifest + {{markers}}
 * on round-trip, so saving does not corrupt the template's field definitions.
 */
export const TemplateDocxEditor = ({
  templateId,
  presignedUrl,
  fileName,
}: {
  templateId: string;
  presignedUrl: string;
  fileName: string;
}) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const activeOrganizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const editorRef = useRef<DocxEditorRef>(null);
  const editorViewRef = useRef<EditorView | null>(null);
  const { containerRef, fitZoom } = useFitToWidth();
  const [isDirty, setIsDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [insertOpen, setInsertOpen] = useState(false);
  const [insertValue, setInsertValue] = useState("");
  const [showDirectives, setShowDirectives] = useState(true);

  const {
    data: loadedBuffer,
    isLoading,
    isError,
  } = useQuery(
    templateDocxBufferOptions(activeOrganizationId, templateId, presignedUrl),
  );

  // Capture the initial bytes once so query refetches (e.g. the detail
  // invalidation after a save) don't swap the buffer reference out from under
  // the editor and discard in-progress edits. The editor owns its state after
  // the first load; a remount re-reads fresh bytes.
  const [docBuffer, setDocBuffer] = useState<ArrayBuffer | null>(null);
  useEffect(() => {
    if (loadedBuffer && docBuffer === null) {
      setDocBuffer(loadedBuffer);
    }
  }, [loadedBuffer, docBuffer]);

  // Folio creates its editable PM view lazily (on first focus), so the captured
  // ref can be null when the user opens the palette without clicking into the
  // document first. Ensure + focus the view, then run the insert (next frame if
  // it had to be created).
  const withEditorView = (perform: (view: EditorView) => void) => {
    if (editorViewRef.current) {
      perform(editorViewRef.current);
      return;
    }
    editorRef.current?.ensureEditorView({ focus: true });
    requestAnimationFrame(() => {
      if (editorViewRef.current) {
        perform(editorViewRef.current);
      }
    });
  };

  const insertInline = (text: string) =>
    withEditorView((view) => {
      const { from, to } = view.state.selection;
      view.dispatch(view.state.tr.insertText(text, from, to).scrollIntoView());
      view.focus();
      setIsDirty(true);
    });

  // Block directives must occupy their own paragraph (the fill engine anchors
  // them line-by-line), so insert opener/body/closer as three paragraphs after
  // the current one.
  const insertBlock = (open: string, close: string) =>
    withEditorView((view) => {
      const { state } = view;
      const paragraph = state.schema.nodes["paragraph"];
      if (!paragraph) {
        return;
      }
      const para = (text: string) =>
        paragraph.create(
          null,
          text.length > 0 ? state.schema.text(text) : null,
        );
      const { $from } = state.selection;
      const pos = $from.depth >= 1 ? $from.after(1) : state.doc.content.size;
      try {
        view.dispatch(
          state.tr
            .insert(pos, [para(open), para(""), para(close)])
            .scrollIntoView(),
        );
        view.focus();
        setIsDirty(true);
      } catch {
        // Selection wasn't in an insertable block context; ignore.
      }
    });

  const runInsert = (kind: "field" | "if" | "each" | "clause") => {
    const value = insertValue.trim();
    if (kind === "field") {
      insertInline(`{{${value || "field"}}}`);
    } else if (kind === "clause") {
      insertInline(`{{@clause:${value || "Clause"}}}`);
    } else if (kind === "if") {
      insertBlock(`{{#if ${value || "condition"}}}`, "{{/if}}");
    } else {
      insertBlock(`{{#each ${value || "items"}}}`, "{{/each}}");
    }
    setInsertValue("");
    setInsertOpen(false);
  };

  const handleSave = async () => {
    const editor = editorRef.current;
    if (!editor) {
      return;
    }

    setIsSaving(true);
    try {
      const buffer = await editor.save();
      if (!buffer) {
        stellaToast.add({ title: t("templates.saveFailed"), type: "error" });
        return;
      }

      const file = new File([buffer], fileName, { type: DOCX_MIME });
      const response = await api
        .templates({ templateId: toSafeId<"template">(templateId) })
        .document.post({ file });

      if (response.error) {
        stellaToast.add({ title: t("templates.saveFailed"), type: "error" });
        return;
      }

      setIsDirty(false);
      stellaToast.add({ title: t("templates.templateSaved"), type: "success" });
      void queryClient.invalidateQueries({
        queryKey: knowledgeKeys.templates.all(activeOrganizationId),
      });
    } catch {
      stellaToast.add({ title: t("templates.saveFailed"), type: "error" });
    } finally {
      setIsSaving(false);
    }
  };

  if (isError) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <p className="text-muted-foreground text-sm">
          {t("templates.previewFailed")}
        </p>
      </div>
    );
  }

  if (isLoading || !docBuffer) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <p className="text-muted-foreground text-sm">{t("common.loading")}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <Popover onOpenChange={setInsertOpen} open={insertOpen}>
          <PopoverTrigger render={<Button size="sm" variant="outline" />}>
            <PlusIcon />
            {t("common.add")}
          </PopoverTrigger>
          <PopoverPopup align="start" className="w-72">
            <div className="flex flex-col gap-2.5">
              <Input
                aria-label={t("common.add")}
                autoFocus
                onChange={(e) => setInsertValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    runInsert("field");
                  }
                }}
                value={insertValue}
              />
              <div className="grid grid-cols-2 gap-1.5">
                {(
                  [
                    { kind: "field", icon: <BracesIcon /> },
                    { kind: "if", icon: <SplitIcon /> },
                    { kind: "each", icon: <RepeatIcon /> },
                    {
                      kind: "clause",
                      icon: (
                        <span className="text-base leading-none font-semibold">
                          §
                        </span>
                      ),
                    },
                  ] as const
                ).map((insert) => (
                  <Button
                    className="justify-start gap-2"
                    key={insert.kind}
                    onClick={() => runInsert(insert.kind)}
                    size="sm"
                    variant="outline"
                  >
                    {insert.icon}
                    {insert.kind}
                  </Button>
                ))}
              </div>
            </div>
          </PopoverPopup>
        </Popover>
        <div className="flex items-center gap-1">
          <Button
            aria-label={t("common.preview")}
            onClick={() => setShowDirectives((v) => !v)}
            size="sm"
            variant="ghost"
          >
            {showDirectives ? <EyeIcon /> : <EyeOffIcon />}
          </Button>
          <Button
            disabled={!isDirty || isSaving}
            onClick={() => void handleSave()}
            size="sm"
          >
            <SaveIcon />
            {t("common.save")}
          </Button>
        </div>
      </div>
      {/* Reserve the scrollbar gutter so the centred page doesn't shift left
          when the vertical scrollbar appears mid-typing (which made the
          directive highlights/rail jitter horizontally). */}
      <div
        className="min-h-0 flex-1 [scrollbar-gutter:stable] overflow-auto"
        ref={containerRef}
      >
        <Suspense fallback={null}>
          <DocxEditor
            ref={editorRef}
            autoOpenReviewSidebar={false}
            className="h-full"
            documentBuffer={docBuffer}
            initialZoom={fitZoom}
            loadingIndicator={null}
            onChange={() => setIsDirty(true)}
            onEditorViewReady={(view) => {
              editorViewRef.current = view;
            }}
            showTemplateDirectives={showDirectives}
          />
        </Suspense>
      </div>
    </div>
  );
};

// ── Fit-to-width ─────────────────────────────────────────

// Letter width at 96 DPI (816px); a touch wider than A4 (794px) so either page
// size fits the column without horizontal scroll. Used only for the initial
// zoom; the editor's own zoom control takes over from there.
const DOCX_PAGE_WIDTH = 816;
const FIT_PADDING = 16;
const MIN_ZOOM = 0.25;
const MAX_FIT_ZOOM = 1;

const clampFitZoom = (zoom: number) =>
  Math.max(MIN_ZOOM, Math.min(MAX_FIT_ZOOM, zoom));

// Callback ref + ResizeObserver rather than a RefObject + useEffect: the real
// container only mounts after the loading state unmounts, and useEffect would
// not re-run on that ref swap.
function useFitToWidth() {
  const [fitZoom, setFitZoom] = useState(MAX_FIT_ZOOM);

  const containerRef = useCallback((node: HTMLElement | null) => {
    if (!node) {
      return undefined;
    }

    const updateZoom = () => {
      const { clientWidth } = node;
      if (clientWidth <= 0) {
        return;
      }
      const available = Math.max(1, clientWidth - FIT_PADDING * 2);
      setFitZoom(
        clampFitZoom(Math.round((available / DOCX_PAGE_WIDTH) * 100) / 100),
      );
    };

    updateZoom();
    const rafId = requestAnimationFrame(updateZoom);
    const observer = new ResizeObserver(updateZoom);
    observer.observe(node);

    return () => {
      cancelAnimationFrame(rafId);
      observer.disconnect();
    };
  }, []);

  return { containerRef, fitZoom };
}
