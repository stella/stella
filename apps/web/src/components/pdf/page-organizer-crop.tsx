import { useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";

import { panic, Result } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "@stll/ui/collapsible";
import {
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogFormState,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from "@stll/ui/dialog";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { ChevronRightIcon } from "@stll/ui/icons";
import { Label } from "@stll/ui/label";
import { NumberInput } from "@stll/ui/number-input";
import { Skeleton } from "@stll/ui/skeleton";
import { cn } from "@stll/ui/utils";

import { useBoxDrag } from "@/hooks/use-box-drag";
import type { BoxDragAdjustment } from "@/hooks/use-box-drag";
import { useMountEffect } from "@/hooks/use-effect";
import { useAnalytics } from "@/lib/analytics/provider";
import { detached } from "@/lib/detached";
import type { PageInfo } from "@/lib/pdf/pdf-context";
import { getCanvasSize, getCanvasTransform } from "@/lib/pdf/utils";

import {
  adjustCropBox,
  clampCropMarginsMm,
  cropKeyDelta,
  cropToMarginsMm,
  displayedCropBox,
  displayedPageSizeMm,
  marginsFromDisplayedBox,
  marginsMmToCrop,
  MIN_CROP_SIZE_MM,
} from "./page-organizer-crop.logic";
import type {
  CropAdjustMode,
  CropMarginsMm,
  CropPageGeometry,
  DisplayedCropBox,
} from "./page-organizer-crop.logic";
import type { NormalizedCrop, OrganizerPage } from "./page-organizer.logic";

export type CropPanelPage = {
  page: OrganizerPage;
  pageInfo: { proxy: Pick<PageInfo["proxy"], "getViewport" | "render"> };
};

export type PageOrganizerCropProps = {
  pages: readonly CropPanelPage[];
  onApply: (crops: ReadonlyMap<string, NormalizedCrop | null>) => void;
  onReset: () => void;
  disabled: boolean;
};

const geometryFor = ({ page, pageInfo }: CropPanelPage): CropPageGeometry => {
  const viewport = pageInfo.proxy.getViewport({ scale: 1, rotation: 0 });
  return {
    width: viewport.width,
    height: viewport.height,
    rotation: page.rotation,
  };
};

const SIDE_LABELS = {
  top: "cropTop",
  right: "cropRight",
  bottom: "cropBottom",
  left: "cropLeft",
} as const satisfies Record<keyof CropMarginsMm, string>;

const isCropSide = (side: string): side is keyof CropMarginsMm =>
  Object.hasOwn(SIDE_LABELS, side);
const HANDLES = {
  n: { label: "cropHandleTop", x: 0.5, y: 0, cursor: "ns-resize" },
  ne: { label: "cropHandleTopRight", x: 1, y: 0, cursor: "nesw-resize" },
  e: { label: "cropHandleRight", x: 1, y: 0.5, cursor: "ew-resize" },
  se: { label: "cropHandleBottomRight", x: 1, y: 1, cursor: "nwse-resize" },
  s: { label: "cropHandleBottom", x: 0.5, y: 1, cursor: "ns-resize" },
  sw: { label: "cropHandleBottomLeft", x: 0, y: 1, cursor: "nesw-resize" },
  w: { label: "cropHandleLeft", x: 0, y: 0.5, cursor: "ew-resize" },
  nw: { label: "cropHandleTopLeft", x: 0, y: 0, cursor: "nwse-resize" },
} as const satisfies Record<
  Exclude<CropAdjustMode, "move">,
  { label: string; x: number; y: number; cursor: string }
>;

type CropMode = CropAdjustMode;

export const PageOrganizerCrop = ({
  pages,
  onApply,
  onReset,
  disabled,
}: PageOrganizerCropProps) => {
  const t = useTranslations("workspaces.pdf.pageEditor");
  const tCommon = useTranslations("common");
  const id = useId();
  const first = pages.at(0) ?? panic("Crop panel requires selected pages");
  // The smallest displayed width and height bound one physical margin draft
  // for every selected page. Measure once, rather than for each drag event.
  const selectionGeometry = useMemo(() => {
    let width = Number.POSITIVE_INFINITY;
    let height = Number.POSITIVE_INFINITY;
    for (const entry of pages) {
      const viewport = entry.pageInfo.proxy.getViewport({
        scale: 1,
        rotation: entry.page.rotation,
      });
      width = Math.min(width, viewport.width);
      height = Math.min(height, viewport.height);
    }
    return { width, height, rotation: 0 as const };
  }, [pages]);
  const [margins, setMargins] = useState(() =>
    clampCropMarginsMm(
      cropToMarginsMm(first.page.crop, geometryFor(first)),
      selectionGeometry,
    ),
  );
  const [activeIndex, setActiveIndex] = useState(0);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const active =
    pages.at(activeIndex) ?? panic("Crop preview references a selected page");
  const geometry = geometryFor(active);
  const box = displayedCropBox(margins, geometry);
  const selectionSize = displayedPageSizeMm(selectionGeometry);
  const canCrop =
    Math.min(selectionSize.width, selectionSize.height) >= MIN_CROP_SIZE_MM;
  const changeMargins = (next: CropMarginsMm) =>
    setMargins(clampCropMarginsMm(next, selectionGeometry));
  const initialMargins = clampCropMarginsMm(
    cropToMarginsMm(first.page.crop, geometryFor(first)),
    selectionGeometry,
  );

  return (
    <>
      <DialogFormState
        dirty={Object.keys(SIDE_LABELS).some((side) => {
          if (!isCropSide(side)) {
            return panic("Unknown crop margin");
          }
          return margins[side] !== initialMargins[side];
        })}
        onDiscard={() => setMargins(initialMargins)}
      />
      <DialogHeader>
        <DialogTitle>{t("cropTitle")}</DialogTitle>
        <DialogDescription>
          {t("cropDescription", { count: pages.length })}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-2">
          <Button
            data-crop-action="previous"
            aria-label={t("cropPreviousPage")}
            disabled={activeIndex === 0}
            onClick={() => setActiveIndex(activeIndex - 1)}
            size="sm"
            variant="outline"
          >
            ←
          </Button>
          <span
            aria-live="polite"
            className="text-muted-foreground text-sm tabular-nums"
          >
            {t("cropPage", { page: activeIndex + 1, count: pages.length })}
          </span>
          <Button
            data-crop-action="next"
            aria-label={t("cropNextPage")}
            disabled={activeIndex === pages.length - 1}
            onClick={() => setActiveIndex(activeIndex + 1)}
            size="sm"
            variant="outline"
          >
            →
          </Button>
        </div>
        <CropPreview
          key={`${active.page.id}:${active.page.rotation}`}
          page={active}
          box={box}
          geometry={geometry}
          disabled={disabled || !canCrop}
          hintId={`${id}-hint`}
          onChange={(next) =>
            changeMargins(marginsFromDisplayedBox(next, geometry))
          }
        />
        <p
          className="text-muted-foreground text-xs text-pretty"
          id={`${id}-hint`}
        >
          {t(canCrop ? "cropHint" : "cropTooSmall")}
        </p>
        <Collapsible onOpenChange={setAdvancedOpen} open={advancedOpen}>
          <CollapsibleTrigger
            render={
              <Button
                className="flex min-h-11"
                data-crop-advanced=""
                variant="plain"
              />
            }
          >
            <span className="flex items-center gap-1 text-sm font-medium">
              <DirectionalIcon
                className={cn(
                  "size-4 shrink-0 transition-transform",
                  advancedOpen && "rotate-90",
                )}
                flip={!advancedOpen}
                icon={ChevronRightIcon}
              />
              {t("cropAdvanced")}
            </span>
          </CollapsibleTrigger>
          {/* Mounted while closed (hidden until found): a drag and the arrow
              keys write the same margins these fields show. */}
          <CollapsiblePanel>
            <div className="grid grid-cols-2 gap-3 pt-1">
              {Object.entries(SIDE_LABELS).map(([side, label]) => {
                if (!isCropSide(side)) {
                  return panic("Unknown crop margin");
                }
                return (
                  <div className="space-y-1.5" key={side}>
                    <Label htmlFor={`${id}-${side}`}>{t(label)}</Label>
                    <NumberInput
                      disabled={disabled || !canCrop}
                      id={`${id}-${side}`}
                      min={0}
                      step={0.1}
                      value={Number(margins[side].toFixed(2))}
                      onValueChange={(value) => {
                        if (value !== null && Number.isFinite(value)) {
                          changeMargins({ ...margins, [side]: value });
                        }
                      }}
                    />
                  </div>
                );
              })}
            </div>
          </CollapsiblePanel>
        </Collapsible>
      </DialogPanel>
      <DialogFooter>
        <Button
          data-crop-action="reset"
          disabled={disabled}
          onClick={onReset}
          variant="ghost"
        >
          {t("resetCrop")}
        </Button>
        <DialogClose render={<Button variant="outline" />}>
          {tCommon("cancel")}
        </DialogClose>
        <Button
          data-crop-action="apply"
          disabled={disabled || !canCrop}
          onClick={() =>
            onApply(
              new Map(
                pages.map((page) => [
                  page.page.id,
                  marginsMmToCrop(margins, geometryFor(page)),
                ]),
              ),
            )
          }
        >
          {t("applyCrop")}
        </Button>
      </DialogFooter>
    </>
  );
};

const CropPreview = ({
  page: { page, pageInfo },
  box,
  geometry,
  disabled,
  hintId,
  onChange,
}: {
  page: CropPanelPage;
  box: DisplayedCropBox;
  geometry: CropPageGeometry;
  disabled: boolean;
  hintId: string;
  onChange: (box: DisplayedCropBox) => void;
}) => {
  const t = useTranslations("workspaces.pdf.pageEditor");
  const analytics = useAnalytics();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "failed">(
    "loading",
  );
  const viewport = pageInfo.proxy.getViewport({
    scale: 1,
    rotation: page.rotation,
  });
  const drag = useBoxDrag({
    box,
    onChange,
    adjust: ({
      box: start,
      delta,
      mode,
    }: BoxDragAdjustment<DisplayedCropBox, CropMode>) =>
      adjustCropBox({ box: start, delta, mode, page: geometry }),
  });

  useMountEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return undefined;
    }
    const lifecycle = { disposed: false };
    const preview = pageInfo.proxy.getViewport({
      scale: Math.min(640 / viewport.width, 480 / viewport.height),
      rotation: page.rotation,
    });
    const size = getCanvasSize(preview);
    canvas.width = size.width;
    canvas.height = size.height;
    let task: ReturnType<PageInfo["proxy"]["render"]> | undefined;
    detached(
      (async () => {
        const result = await Result.tryPromise(async () => {
          task = pageInfo.proxy.render({
            canvas,
            viewport: preview,
            transform: getCanvasTransform(),
          });
          await task.promise;
        });
        if (lifecycle.disposed) {
          return;
        }
        if (Result.isError(result)) {
          analytics.captureError(result.error, {
            fingerprintKey: "CropPreview:failure",
            scope: { type: "handler", handlerId: "CropPreview:failure" },
          });
          setStatus("failed");
          return;
        }
        setStatus("ready");
      })(),
      "pdf-page-organizer.crop-preview",
    );
    return () => {
      lifecycle.disposed = true;
      task?.cancel();
    };
  });

  const nudge = (event: KeyboardEvent<HTMLButtonElement>, mode: CropMode) => {
    const deltaMm = cropKeyDelta(event.key, event.shiftKey);
    if (!deltaMm) {
      return;
    }
    event.preventDefault();
    const size = displayedPageSizeMm(geometry);
    onChange(
      adjustCropBox({
        box,
        delta: { x: deltaMm.x / size.width, y: deltaMm.y / size.height },
        mode,
        page: geometry,
      }),
    );
  };
  const controlProps = (mode: CropMode) => ({
    onPointerMove: drag.onPointerMove,
    onPointerUp: drag.onPointerUp,
    onPointerCancel: drag.onPointerCancel,
    onLostPointerCapture: drag.onLostPointerCapture,
    disabled: disabled || status !== "ready",
    onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => nudge(event, mode),
    onPointerDown: (event: PointerEvent<HTMLButtonElement>) => {
      if (surfaceRef.current && !disabled && status === "ready") {
        drag.startDrag(event, { mode, surface: surfaceRef.current });
      }
    },
  });

  return (
    <div className="bg-muted/50 flex shrink-0 justify-center rounded-md p-6">
      <div
        className="relative isolate w-full shadow-sm"
        dir="ltr"
        ref={surfaceRef}
        style={{
          aspectRatio: `${viewport.width} / ${viewport.height}`,
          maxWidth: `min(640px, calc(45dvh * ${viewport.width / viewport.height}))`,
        }}
      >
        <canvas
          aria-label={t("cropPreview", { page: page.sourcePageIndex + 1 })}
          className="block size-full"
          ref={canvasRef}
          role="img"
        />
        {status === "loading" && <Skeleton className="absolute inset-0" />}
        {status === "failed" && (
          <p
            className="bg-background absolute inset-0 flex items-center justify-center p-4 text-sm"
            role="alert"
          >
            {t("cropPreviewFailed")}
          </p>
        )}
        {status === "ready" && (
          <div className="pointer-events-none absolute inset-0 overflow-hidden">
            <div
              style={{
                left: `${box.x * 100}%`,
                top: `${box.y * 100}%`,
                width: `${box.width * 100}%`,
                height: `${box.height * 100}%`,
                boxShadow:
                  "0 0 0 100vmax color-mix(in srgb, var(--foreground) 40%, transparent)",
              }}
              className="absolute"
            />
          </div>
        )}
        {status === "ready" && (
          <div
            className="border-primary pointer-events-none absolute border-2"
            data-crop-box=""
            style={{
              left: `${box.x * 100}%`,
              top: `${box.y * 100}%`,
              width: `${box.width * 100}%`,
              height: `${box.height * 100}%`,
            }}
          >
            <Button
              {...controlProps("move")}
              aria-describedby={hintId}
              aria-label={t("cropMove")}
              className="pointer-events-auto absolute inset-0 cursor-move touch-none"
              variant="plain"
            />
            {Object.entries(HANDLES).map(([mode, handle]) => {
              if (!isHandleMode(mode)) {
                return panic("Unknown crop handle");
              }
              return (
                <Button
                  {...controlProps(mode)}
                  key={mode}
                  data-crop-handle={mode}
                  aria-describedby={hintId}
                  aria-label={t("cropHandle", { position: t(handle.label) })}
                  className="pointer-events-auto absolute z-10 flex size-11 -translate-x-1/2 -translate-y-1/2 touch-none items-center justify-center"
                  variant="plain"
                  style={{
                    left: `${handle.x * 100}%`,
                    top: `${handle.y * 100}%`,
                    cursor: handle.cursor,
                  }}
                >
                  <span
                    aria-hidden
                    className="bg-background border-primary size-2.5 rounded-sm border-2"
                  />
                </Button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

const isHandleMode = (mode: string): mode is keyof typeof HANDLES =>
  Object.hasOwn(HANDLES, mode);
