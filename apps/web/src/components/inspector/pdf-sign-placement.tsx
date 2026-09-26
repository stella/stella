import { useId, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

import { useQuery } from "@tanstack/react-query";
import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from "@stll/ui/dialog";
import { Label } from "@stll/ui/label";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";
import { Skeleton } from "@stll/ui/skeleton";
import { cn } from "@stll/ui/utils";

import { useMountEffect } from "@/hooks/use-effect";
import { getLangDir, useI18nStore } from "@/i18n/i18n-store";
import { resolveAppTimeZone } from "@/i18n/time-zone";
import { detached } from "@/lib/detached";
import { fileOptions } from "@/lib/files/queries";
import {
  adjustStampBox,
  canPlaceStamp,
  defaultStampBox,
  type PdfSigningStamp,
  previewDeltaToPoints,
  type StampAdjustMode,
  type StampBox,
  stampKeyAdjustment,
  type StampPageSize,
} from "@/lib/pdf-signing-stamp.logic";
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PDFPageProxy,
} from "@/lib/pdf/pdfjs-loader";
import { loadPdfjs } from "@/lib/pdf/pdfjs-loader";
import { getDevicePixelRatio } from "@/lib/pdf/utils";

type StampPlacement = {
  box: StampBox;
  page: StampPageSize;
  pageIndex: number;
};

type PlacementChange = (placement: StampPlacement | null) => void;

type SignatureMode = "invisible" | "visible";

// The preview's render budget; the page is drawn to fit inside it.
const PREVIEW_MAX_WIDTH_PX = 464;
const PREVIEW_MAX_HEIGHT_PX = 352;
const PREVIEW_MAX_HEIGHT_CSS = "min(22rem, 45dvh)";
// Placeholder proportions (A4 portrait) while the page is not measured yet.
const PLACEHOLDER_PAGE = { height: 841.89, width: 595.28 } as const;

const pageFrameStyle = (page: StampPageSize): CSSProperties => ({
  aspectRatio: `${String(page.width)} / ${String(page.height)}`,
  width: `min(100%, calc(${PREVIEW_MAX_HEIGHT_CSS} * ${String(page.width / page.height)}))`,
});

const percent = (fraction: number) => `${String(fraction * 100)}%`;

type PdfSignPlacementProps = {
  fieldId: string;
  onConfirm: (stamp: PdfSigningStamp | undefined) => void;
  workspaceId: string;
};

/** Dialog body: choose an invisible signature or place a visible stamp. */
export const PdfSignPlacement = ({
  fieldId,
  onConfirm,
  workspaceId,
}: PdfSignPlacementProps) => {
  const t = useTranslations();
  const loadedLang = useI18nStore((state) => state.loadedLang);
  const [mode, setMode] = useState<SignatureMode>("invisible");
  const [placement, setPlacement] = useState<StampPlacement | null>(null);
  const radioName = useId();

  const selectMode = (next: SignatureMode) => {
    setMode(next);
    setPlacement(null);
  };

  const confirm = () => {
    if (mode === "invisible") {
      onConfirm(undefined);
      return;
    }
    if (placement === null) {
      return;
    }
    onConfirm({
      box: placement.box,
      direction: getLangDir(loadedLang),
      labels: {
        date: t("common.date"),
        location: t("workspaces.files.pdfSigning.stampLocation"),
        reason: t("workspaces.files.pdfSigning.stampReason"),
        signedBy: t("workspaces.files.pdfSigning.stampSignedBy"),
      },
      pageIndex: placement.pageIndex,
      timeZone: resolveAppTimeZone(),
    });
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {t("workspaces.files.pdfSigning.placementTitle")}
        </DialogTitle>
        <DialogDescription>
          {t("workspaces.files.pdfSigning.placementDescription")}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="flex flex-col gap-4">
          <fieldset className="flex flex-col gap-2">
            <legend className="sr-only">
              {t("workspaces.files.pdfSigning.placementDescription")}
            </legend>
            <ModeOption
              checked={mode === "invisible"}
              description={t(
                "workspaces.files.pdfSigning.placementInvisibleDescription",
              )}
              label={t("workspaces.files.pdfSigning.placementInvisible")}
              name={radioName}
              onSelect={() => selectMode("invisible")}
              value="invisible"
            />
            <ModeOption
              checked={mode === "visible"}
              description={t(
                "workspaces.files.pdfSigning.placementVisibleDescription",
              )}
              label={t("workspaces.files.pdfSigning.placementVisible")}
              name={radioName}
              onSelect={() => selectMode("visible")}
              value="visible"
            />
          </fieldset>
          {mode === "visible" && (
            <StampFile
              fieldId={fieldId}
              onPlacementChange={setPlacement}
              placement={placement}
              workspaceId={workspaceId}
            />
          )}
        </div>
      </DialogPanel>
      <DialogFooter>
        <DialogClose render={<Button variant="ghost" />}>
          {t("common.cancel")}
        </DialogClose>
        <Button
          disabled={mode === "visible" && placement === null}
          onClick={confirm}
        >
          {t("workspaces.files.pdfSigning.placementConfirm")}
        </Button>
      </DialogFooter>
    </>
  );
};

const ModeOption = ({
  checked,
  description,
  label,
  name,
  onSelect,
  value,
}: {
  checked: boolean;
  description: string;
  label: string;
  name: string;
  onSelect: () => void;
  value: SignatureMode;
}) => (
  <label
    aria-label={label}
    className="has-[:checked]:border-primary has-[:checked]:bg-muted/50 flex min-h-11 cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors"
  >
    <input
      checked={checked}
      className="accent-primary mt-0.5 size-4 shrink-0"
      name={name}
      onChange={onSelect}
      type="radio"
      value={value}
    />
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="text-sm font-medium">{label}</span>
      <span className="text-muted-foreground text-xs">{description}</span>
    </span>
  </label>
);

const PagePlaceholder = () => (
  <div className="relative mx-auto" style={pageFrameStyle(PLACEHOLDER_PAGE)}>
    <Skeleton className="absolute inset-0 rounded-sm" />
  </div>
);

const PreviewMessage = ({ children }: { children: ReactNode }) => (
  <p className="text-muted-foreground text-sm" role="status">
    {children}
  </p>
);

type StampEditorProps = {
  onPlacementChange: PlacementChange;
  placement: StampPlacement | null;
};

const StampFile = ({
  fieldId,
  workspaceId,
  ...editor
}: StampEditorProps & { fieldId: string; workspaceId: string }) => {
  const t = useTranslations();
  // Same bytes, and cache entry, as the viewer beside the dialog.
  const fileQuery = useQuery(
    fileOptions({ fieldId, purpose: "display", workspaceId }),
  );

  if (fileQuery.isError) {
    return (
      <PreviewMessage>
        {t("workspaces.files.pdfSigning.placementPreviewFailed")}
      </PreviewMessage>
    );
  }
  if (fileQuery.data === undefined) {
    return <PagePlaceholder />;
  }
  return (
    <StampDocument
      buffer={fileQuery.data.buffer}
      key={fileQuery.data.fileId}
      {...editor}
    />
  );
};

type DocumentState =
  | { status: "failed" }
  | { status: "loading" }
  | { document: PDFDocumentProxy; status: "ready" };

const StampDocument = ({
  buffer,
  onPlacementChange,
  placement,
}: StampEditorProps & { buffer: ArrayBuffer }) => {
  const t = useTranslations();
  const selectId = useId();
  const [state, setState] = useState<DocumentState>({ status: "loading" });
  const [pageIndex, setPageIndex] = useState<number | null>(null);

  // The parsed document lives in the pdf.js worker until it is destroyed.
  useMountEffect(() => {
    let disposed = false;
    let loadingTask: PDFDocumentLoadingTask | null = null;

    const load = async () => {
      const loaded = await Result.tryPromise(async () => {
        const pdfjs = await loadPdfjs();
        if (disposed) {
          return null;
        }
        const task = pdfjs.getDocument({ data: buffer.slice(0) });
        loadingTask = task;
        return await task.promise;
      });
      if (disposed) {
        return;
      }
      setState(
        Result.isOk(loaded) && loaded.value !== null
          ? { document: loaded.value, status: "ready" }
          : { status: "failed" },
      );
    };

    detached(load(), "pdf-sign-placement.load-document");
    return () => {
      disposed = true;
      if (loadingTask !== null) {
        detached(loadingTask.destroy(), "pdf-sign-placement.destroy-document");
      }
    };
  });

  if (state.status === "loading") {
    return <PagePlaceholder />;
  }
  if (state.status === "failed") {
    return (
      <PreviewMessage>
        {t("workspaces.files.pdfSigning.placementPreviewFailed")}
      </PreviewMessage>
    );
  }

  const pageCount = state.document.numPages;
  const selectedPage = Math.min(pageIndex ?? pageCount - 1, pageCount - 1);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <Label htmlFor={selectId}>{t("common.page")}</Label>
        <Select
          onValueChange={(value) => {
            if (value === null || value === selectedPage) {
              return;
            }
            setPageIndex(value);
            onPlacementChange(null);
          }}
          value={selectedPage}
        >
          <SelectTrigger className="w-auto" id={selectId} size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {Array.from({ length: pageCount }, (_, index) => (
              <SelectItem key={index} value={index}>
                {t("workspaces.files.pdfSigning.placementPageOption", {
                  count: pageCount,
                  page: index + 1,
                })}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
      <StampPage
        document={state.document}
        key={selectedPage}
        onPlacementChange={onPlacementChange}
        pageIndex={selectedPage}
        placement={placement?.pageIndex === selectedPage ? placement : null}
      />
    </div>
  );
};

type PageState =
  | { status: "failed" }
  | { status: "loading" }
  | { page: StampPageSize; status: "ready" };

type RenderTask = ReturnType<PDFPageProxy["render"]>;

const StampPage = ({
  document,
  onPlacementChange,
  pageIndex,
  placement,
}: StampEditorProps & { document: PDFDocumentProxy; pageIndex: number }) => {
  const t = useTranslations();
  const hintId = useId();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<PageState>({ status: "loading" });

  // pdf.js applies the page's rotation and crop box, so the canvas shows the
  // page as displayed and its scale-1 viewport is the page size in points.
  useMountEffect(() => {
    let disposed = false;
    let renderTask: RenderTask | null = null;

    const render = async () => {
      const rendered = await Result.tryPromise(async () => {
        const proxy = await document.getPage(pageIndex + 1);
        const canvas = canvasRef.current;
        const context = canvas?.getContext("2d");
        if (disposed || !canvas || !context) {
          return null;
        }
        const base = proxy.getViewport({ scale: 1 });
        const fit = Math.min(
          PREVIEW_MAX_WIDTH_PX / base.width,
          PREVIEW_MAX_HEIGHT_PX / base.height,
        );
        const viewport = proxy.getViewport({
          scale: fit * getDevicePixelRatio(),
        });
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const task = proxy.render({ canvas, canvasContext: context, viewport });
        renderTask = task;
        await task.promise;
        return { height: base.height, width: base.width };
      });
      if (disposed) {
        return;
      }
      if (Result.isError(rendered) || rendered.value === null) {
        setState({ status: "failed" });
        return;
      }
      const page = rendered.value;
      setState({ page, status: "ready" });
      if (canPlaceStamp(page)) {
        onPlacementChange({ box: defaultStampBox(page), page, pageIndex });
      }
    };

    detached(render(), "pdf-sign-placement.render-page");
    return () => {
      disposed = true;
      renderTask?.cancel();
    };
  });

  if (state.status === "failed") {
    return (
      <PreviewMessage>
        {t("workspaces.files.pdfSigning.placementPreviewFailed")}
      </PreviewMessage>
    );
  }

  const page = state.status === "ready" ? state.page : null;

  return (
    <div className="flex flex-col gap-2">
      {/* The page keeps its own orientation under an RTL interface. */}
      <div
        className="outline-border relative mx-auto overflow-hidden rounded-sm shadow-sm outline"
        dir="ltr"
        style={pageFrameStyle(page ?? PLACEHOLDER_PAGE)}
      >
        <canvas
          aria-label={t("workspaces.files.pdfSigning.placementPreview", {
            page: pageIndex + 1,
          })}
          className={cn("block size-full", page === null && "invisible")}
          ref={canvasRef}
          role="img"
        />
        {page === null && <Skeleton className="absolute inset-0" />}
        {placement !== null && (
          <StampBoxControl
            describedBy={hintId}
            onChange={(box) => onPlacementChange({ ...placement, box })}
            placement={placement}
          />
        )}
      </div>
      {page !== null && !canPlaceStamp(page) ? (
        <PreviewMessage>
          {t("workspaces.files.pdfSigning.placementTooSmall")}
        </PreviewMessage>
      ) : (
        <p className="text-muted-foreground text-xs text-pretty" id={hintId}>
          {t("workspaces.files.pdfSigning.placementHint")}
        </p>
      )}
    </div>
  );
};

type Drag = {
  box: StampBox;
  mode: StampAdjustMode;
  origin: { x: number; y: number };
  pointerId: number;
  preview: StampPageSize;
};

const StampBoxControl = ({
  describedBy,
  onChange,
  placement,
}: {
  describedBy: string;
  onChange: (box: StampBox) => void;
  placement: StampPlacement;
}) => {
  const t = useTranslations();
  const dragRef = useRef<Drag | null>(null);
  const { box, page } = placement;

  const endDrag = (pointerId: number) => {
    if (dragRef.current?.pointerId === pointerId) {
      dragRef.current = null;
    }
  };

  return (
    <button
      aria-describedby={describedBy}
      aria-label={t("workspaces.files.pdfSigning.placementBox")}
      // Drawn at the stamp's true size; an invisible layer around a small
      // box keeps it at least 44px to grab.
      className="border-primary bg-primary/10 text-primary focus-visible:ring-ring/50 absolute flex cursor-move touch-none items-start border text-start outline-none select-none before:absolute before:start-1/2 before:top-1/2 before:size-full before:min-h-11 before:min-w-11 before:-translate-x-1/2 before:-translate-y-1/2 before:content-[''] focus-visible:ring-2"
      onKeyDown={(event) => {
        const adjustment = stampKeyAdjustment({
          key: event.key,
          shiftKey: event.shiftKey,
        });
        if (adjustment === null) {
          return;
        }
        event.preventDefault();
        onChange(adjustStampBox({ box, page, ...adjustment }));
      }}
      onLostPointerCapture={(event) => endDrag(event.pointerId)}
      onPointerCancel={(event) => endDrag(event.pointerId)}
      onPointerDown={(event) => {
        const surface = event.currentTarget.parentElement;
        if (event.button !== 0 || surface === null) {
          return;
        }
        const rect = surface.getBoundingClientRect();
        const onHandle =
          event.target instanceof Element &&
          event.target.closest("[data-stamp-resize]") !== null;
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.focus({ preventScroll: true });
        dragRef.current = {
          box,
          mode: onHandle ? "resize" : "move",
          origin: { x: event.clientX, y: event.clientY },
          pointerId: event.pointerId,
          preview: { height: rect.height, width: rect.width },
        };
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (drag?.pointerId !== event.pointerId) {
          return;
        }
        onChange(
          adjustStampBox({
            box: drag.box,
            deltaPt: previewDeltaToPoints({
              delta: {
                x: event.clientX - drag.origin.x,
                y: event.clientY - drag.origin.y,
              },
              page,
              preview: drag.preview,
            }),
            mode: drag.mode,
            page,
          }),
        );
      }}
      onPointerUp={(event) => endDrag(event.pointerId)}
      style={{
        height: percent(box.height),
        insetInlineStart: percent(box.x),
        top: percent(box.y),
        width: percent(box.width),
      }}
      type="button"
    >
      <span className="text-2xs max-h-full min-w-0 truncate p-1 leading-tight">
        {t("workspaces.files.pdfSigning.stampSignedBy")}
      </span>
      {/* A 44px target centred on the visible corner square. */}
      <span
        aria-hidden
        className="absolute -end-5.5 -bottom-5.5 z-10 flex size-11 cursor-nwse-resize items-center justify-center"
        data-stamp-resize=""
      >
        <span className="bg-primary size-2.5" />
      </span>
    </button>
  );
};
