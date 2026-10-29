import { useId } from "react";

import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { cn } from "@stll/ui/utils";

import {
  cancelPdfSignDrawing,
  confirmPdfSignPlacement,
  endPdfSignPlacement,
  finishPdfSignDrawing,
  movePdfSignDrawing,
  type PdfSignPlacementSession,
  setPdfSignDraft,
  showPdfSignNotice,
  type StampDraft,
  startPdfSignDrawing,
  usePdfSignPlacementStore,
} from "@/components/inspector/pdf-sign-placement-store";
import {
  adjustStampBox,
  canPlaceStamp,
  clampPagePoint,
  defaultStampBox,
  drawnStampBox,
  type PagePoint,
  previewDeltaToPoints,
  type StampAdjustMode,
  type StampBox,
  stampKeyAdjustment,
  type StampPageSize,
  type StampSizeCheck,
  stampSizeCheck,
} from "@/components/inspector/pdf-signing-stamp.logic";
import { type BoxDragAdjustment, useBoxDrag } from "@/hooks/use-box-drag";
import { useMountEffect } from "@/hooks/use-effect";
import { getLangDir, useI18nStore } from "@/i18n/i18n-store";
import { resolveAppTimeZone } from "@/i18n/time-zone";
import type { TranslationKey } from "@/i18n/types";

const percent = (fraction: number) => `${String(fraction * 100)}%`;

const boxStyle = (box: StampBox) => ({
  height: percent(box.height),
  insetInlineStart: percent(box.x),
  top: percent(box.y),
  width: percent(box.width),
});

const NO_POINT: PagePoint = { x: 0, y: 0 };

type PdfSignPlacementPageProps = {
  /** The page as displayed, in points. */
  page: StampPageSize;
  pageIndex: number;
};

/** The drawing surface over one page, positioned against the page box. */
export const PdfSignPlacementPage = ({
  page,
  pageIndex,
}: PdfSignPlacementPageProps) => {
  const t = useTranslations();
  const draft = usePdfSignPlacementStore((state) =>
    state.session?.draft?.pageIndex === pageIndex ? state.session.draft : null,
  );
  const drawing = usePdfSignPlacementStore((state) =>
    state.session?.drawing?.pageIndex === pageIndex
      ? state.session.drawing
      : null,
  );
  // The drag reports where the pointer is, as a point on the page; the box
  // it spans from the anchor is derived from that.
  const { startDrag, ...dragHandlers } = useBoxDrag<PagePoint, "draw">({
    adjust: ({ box: anchor, delta }) =>
      clampPagePoint({ x: anchor.x + delta.x, y: anchor.y + delta.y }),
    box: NO_POINT,
    onChange: movePdfSignDrawing,
  });
  const drawnBox = drawing === null ? null : drawnStampBox(drawing);

  return (
    // The page keeps its own orientation under an RTL interface.
    <div
      aria-hidden={draft === null ? true : undefined}
      className="absolute inset-0 z-20 cursor-crosshair touch-none select-none"
      data-pdf-sign-placement-page={pageIndex + 1}
      dir="ltr"
      onLostPointerCapture={(event) => {
        dragHandlers.onLostPointerCapture(event);
        cancelPdfSignDrawing(event.pointerId);
      }}
      onPointerCancel={(event) => {
        dragHandlers.onPointerCancel(event);
        cancelPdfSignDrawing(event.pointerId);
      }}
      onPointerDown={(event) => {
        // The stamp handles its own drags; only the bare page draws.
        if (event.button !== 0 || event.target !== event.currentTarget) {
          return;
        }
        event.preventDefault();
        if (!canPlaceStamp(page)) {
          showPdfSignNotice("page_too_small");
          return;
        }
        const rect = event.currentTarget.getBoundingClientRect();
        const anchor = clampPagePoint({
          x: rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0,
          y: rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0,
        });
        startPdfSignDrawing({
          anchor,
          current: anchor,
          page,
          pageIndex,
          pointerId: event.pointerId,
        });
        startDrag(event, {
          from: anchor,
          mode: "draw",
          surface: event.currentTarget,
        });
      }}
      onPointerMove={dragHandlers.onPointerMove}
      onPointerUp={(event) => {
        // Settle before the drag lets go, so losing capture cancels nothing.
        finishPdfSignDrawing(event.pointerId);
        dragHandlers.onPointerUp(event);
      }}
    >
      {drawnBox !== null && (
        <DrawnBoxPreview
          check={stampSizeCheck(drawnBox, page)}
          label={t("workspaces.files.pdfSigning.stampSignedBy")}
          box={drawnBox}
        />
      )}
      {drawnBox === null && draft !== null && <StampBoxControl draft={draft} />}
    </div>
  );
};

const DrawnBoxPreview = ({
  box,
  check,
  label,
}: {
  box: StampBox;
  check: StampSizeCheck;
  label: string;
}) => (
  <div
    className={cn(
      "pointer-events-none absolute flex items-start border text-start",
      check === "fits"
        ? "border-primary bg-primary/10 text-primary"
        : "border-destructive bg-destructive/10 text-destructive border-dashed",
    )}
    data-stamp-preview={check}
    style={boxStyle(box)}
  >
    <span className="text-2xs max-h-full min-w-0 truncate p-1 leading-tight">
      {label}
    </span>
  </div>
);

const StampBoxControl = ({ draft }: { draft: StampDraft }) => {
  const t = useTranslations();
  const hintId = useId();
  const { box, page } = draft;
  const onChange = (next: StampBox) => setPdfSignDraft({ ...draft, box: next });
  const { startDrag, ...pointerHandlers } = useBoxDrag({
    adjust: ({
      box: initialBox,
      delta,
      mode,
    }: BoxDragAdjustment<StampBox, StampAdjustMode>) =>
      adjustStampBox({
        box: initialBox,
        deltaPt: previewDeltaToPoints({
          delta,
          page,
          preview: { height: 1, width: 1 },
        }),
        mode,
        page,
      }),
    box,
    onChange,
  });

  return (
    <Button
      aria-describedby={hintId}
      aria-label={t("workspaces.files.pdfSigning.placementBox")}
      className="absolute flex cursor-move touch-none items-start select-none"
      data-stamp-box=""
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
      onPointerDown={(event) => {
        const surface = event.currentTarget.parentElement;
        if (surface === null) {
          return;
        }
        const onHandle =
          event.target instanceof Element &&
          event.target.closest("[data-stamp-resize]") !== null;
        startDrag(event, { mode: onHandle ? "resize" : "move", surface });
      }}
      {...pointerHandlers}
      style={boxStyle(box)}
      variant="plain"
    >
      {/* The stamp outline, drawn at the box's true size. An invisible layer
          around a small box keeps it at least 44px to grab, equally on every
          side in either direction. */}
      <span
        aria-hidden
        className="border-primary bg-primary/10 absolute inset-0 border before:absolute before:inset-x-[min(0px,calc(50%-1.375rem))] before:inset-y-[min(0px,calc(50%-1.375rem))] before:content-['']"
      />
      <span className="text-primary text-2xs relative max-h-full min-w-0 truncate p-1 leading-tight">
        {t("workspaces.files.pdfSigning.stampSignedBy")}
      </span>
      <span className="sr-only" id={hintId}>
        {t("workspaces.files.pdfSigning.placementHint")}
      </span>
      {/* A 44px target centred on the visible corner square. */}
      <span
        aria-hidden
        className="absolute -end-5.5 -bottom-5.5 z-10 flex size-11 cursor-nwse-resize items-center justify-center"
        data-stamp-resize=""
      >
        <span className="bg-primary size-2.5" />
      </span>
    </Button>
  );
};

/** The default stamp, bottom-right on a page, when the page can hold one. */
export const placeDefaultStamp = ({
  page,
  pageIndex,
}: PdfSignPlacementPageProps) => {
  if (!canPlaceStamp(page)) {
    showPdfSignNotice("page_too_small");
    return;
  }
  setPdfSignDraft({ box: defaultStampBox(page), page, pageIndex });
};

/**
 * Every line the bar can show. Kept to this narrow union: handing `t` the
 * whole catalogue's key union makes its parameter types too complex to check.
 */
const STATUS_KEYS = {
  attachmentsOnly: "workspaces.files.pdfSigning.placementAttachmentsOnly",
  drawTooLarge: "workspaces.files.pdfSigning.placementDrawTooLarge",
  drawTooSmall: "workspaces.files.pdfSigning.placementDrawTooSmall",
  modeHint: "workspaces.files.pdfSigning.placementModeHint",
  pageTooSmall: "workspaces.files.pdfSigning.placementTooSmall",
  redrawHint: "workspaces.files.pdfSigning.placementRedrawHint",
} as const satisfies Record<string, TranslationKey>;

type PlacementStatusKey = (typeof STATUS_KEYS)[keyof typeof STATUS_KEYS];

const DRAWING_STATUS_KEYS = {
  fits: STATUS_KEYS.modeHint,
  too_large: STATUS_KEYS.drawTooLarge,
  too_small: STATUS_KEYS.drawTooSmall,
} as const satisfies Record<StampSizeCheck, PlacementStatusKey>;

const placementStatus = ({
  session,
}: {
  session: PdfSignPlacementSession | null;
}): PlacementStatusKey => {
  if (session === null) {
    return STATUS_KEYS.modeHint;
  }
  if (session.drawing !== null) {
    return DRAWING_STATUS_KEYS[
      stampSizeCheck(drawnStampBox(session.drawing), session.drawing.page)
    ];
  }
  if (session.notice === "page_too_small") {
    return STATUS_KEYS.pageTooSmall;
  }
  return session.draft === null ? STATUS_KEYS.modeHint : STATUS_KEYS.redrawHint;
};

type PdfSignPlacementControlsProps = {
  /** Offered while no stamp is drawn: a way to place one without a pointer. */
  onPlaceOnLastPage?: (() => void) | undefined;
  /** `false` when the viewer shows a portfolio's attachments instead. */
  showsOwnPages: boolean;
};

/**
 * What to do on the page, and the choice to sign with the stamp, without
 * one, or not at all. Escape cancels.
 */
export const PdfSignPlacementControls = ({
  onPlaceOnLastPage,
  showsOwnPages,
}: PdfSignPlacementControlsProps) => {
  const t = useTranslations();
  const loadedLang = useI18nStore((state) => state.loadedLang);
  const draft = usePdfSignPlacementStore(
    (state) => state.session?.draft ?? null,
  );
  const status = usePdfSignPlacementStore((state) =>
    showsOwnPages ? placementStatus(state) : STATUS_KEYS.attachmentsOnly,
  );

  useMountEffect(() => {
    const controller = new AbortController();
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          endPdfSignPlacement();
        }
      },
      { signal: controller.signal },
    );
    return () => controller.abort();
  });

  const signWithStamp = () => {
    if (draft === null) {
      return;
    }
    confirmPdfSignPlacement({
      box: draft.box,
      direction: getLangDir(loadedLang),
      labels: {
        date: t("common.date"),
        location: t("workspaces.files.pdfSigning.stampLocation"),
        reason: t("common.reason"),
        signedBy: t("workspaces.files.pdfSigning.stampSignedBy"),
      },
      pageIndex: draft.pageIndex,
      timeZone: resolveAppTimeZone(),
    });
  };

  return (
    <div className="pointer-events-none absolute inset-x-0 top-2 z-40 flex justify-center px-2">
      <div
        aria-label={t("workspaces.files.pdfSigning.placementTitle")}
        className="bg-popover text-popover-foreground ring-border pointer-events-auto flex max-w-full flex-wrap items-center gap-2 rounded-lg px-3 py-2 shadow-lg ring-1"
        role="group"
      >
        <p
          aria-live="polite"
          className="min-w-0 flex-1 basis-48 text-sm text-pretty"
        >
          {t(status)}
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          {draft === null && showsOwnPages && onPlaceOnLastPage && (
            <Button onClick={onPlaceOnLastPage} size="sm" variant="ghost">
              {t("workspaces.files.pdfSigning.placementPlaceOnLastPage")}
            </Button>
          )}
          <Button onClick={endPdfSignPlacement} size="sm" variant="ghost">
            {t("common.cancel")}
          </Button>
          <Button
            onClick={() => confirmPdfSignPlacement(undefined)}
            size="sm"
            variant="outline"
          >
            {t("workspaces.files.pdfSigning.placementSignInvisible")}
          </Button>
          <Button disabled={draft === null} onClick={signWithStamp} size="sm">
            {t("workspaces.files.pdfSigning.placementSignVisible")}
          </Button>
        </div>
      </div>
    </div>
  );
};
