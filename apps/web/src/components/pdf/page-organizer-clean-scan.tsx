import { useId, useState } from "react";

import { panic } from "better-result";
import { useTranslations } from "use-intl";

import type { CleanScanPageReview } from "@stll/scan-engine/review";
import type { CleanedScanImage, ScanOptions } from "@stll/scan-engine/types";
import { Button } from "@stll/ui/button";
import {
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from "@stll/ui/dialog";
import { CheckIcon, Undo2Icon } from "@stll/ui/icons";
import { Label } from "@stll/ui/label";
import { Loader } from "@stll/ui/loader";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";
import { Switch } from "@stll/ui/switch";
import { cn } from "@stll/ui/utils";

import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useFormatter } from "@/i18n/formatting-context";
import { drawCleanScanPage } from "@/lib/pdf/page-editor/clean-scan-canvas";
import type {
  CleanScanFailure,
  CleanScanGeometry,
} from "@/lib/pdf/page-editor/clean-scan-run";
import { getDevicePixelRatio } from "@/lib/pdf/utils";

import type { CleanScanSession, PageRotation } from "./page-organizer.logic";

const PREVIEW_WIDTH_PX = 224;

const OUTPUT_LABEL_KEYS = {
  grayscale: "outputGrayscale",
  binary: "outputBinary",
} as const satisfies Record<ScanOptions["output"], string>;

/**
 * Copy for each reason the engine gives for leaving a page alone. The engine
 * types the reason as a string, so an unlisted one gets the generic copy and
 * is reported as a defect.
 */
const UNRECOGNIZED_REASON_KEYS = {
  "no-content": "unrecognizedNoContent",
  "too-large": "unrecognizedTooLarge",
  "degenerate-page-quad": "unrecognizedNoPage",
  "invalid-dimensions": "unrecognized",
  "invalid-dpi": "unrecognized",
  "invalid-pixel-buffer": "unrecognized",
} as const;

export const isKnownUnrecognizedReason = (
  reason: string,
): reason is keyof typeof UNRECOGNIZED_REASON_KEYS =>
  Object.hasOwn(UNRECOGNIZED_REASON_KEYS, reason);

const FAILURE_KEYS = {
  "engine-failure": "failedEngine",
  "engine-timeout": "failedTimeout",
  "render-failure": "failedRender",
} as const satisfies Record<CleanScanFailure["reason"], string>;

const isOutput = (value: unknown): value is ScanOptions["output"] =>
  value === "grayscale" || value === "binary";

type UnrecognizedReasonKey =
  (typeof UNRECOGNIZED_REASON_KEYS)[keyof typeof UNRECOGNIZED_REASON_KEYS];

const unrecognizedReasonKey = (reason: string): UnrecognizedReasonKey =>
  isKnownUnrecognizedReason(reason)
    ? UNRECOGNIZED_REASON_KEYS[reason]
    : "unrecognized";

type CleanScanPreviewProps = {
  geometry: CleanScanGeometry;
  image: CleanedScanImage;
  label: string;
  muted: boolean;
  rotation: PageRotation;
};

const CleanScanPreview = ({
  geometry,
  image,
  label,
  muted,
  rotation,
}: CleanScanPreviewProps) => {
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  useExternalSyncEffect(() => {
    if (!canvas) {
      return undefined;
    }
    drawCleanScanPage({
      canvas,
      rotation,
      scan: { ...geometry, image },
      widthPx: PREVIEW_WIDTH_PX * getDevicePixelRatio(),
    });
    return undefined;
  }, [canvas, geometry, image, rotation]);
  return (
    <canvas
      aria-label={label}
      className={cn(
        "bg-card block w-full rounded-sm border",
        muted && "opacity-50",
      )}
      ref={setCanvas}
      role="img"
    />
  );
};

export type CleanScanPageContext = {
  pageNumber: string;
  rotation: PageRotation;
};

type CleanScanReviewAction =
  | { type: "applyCleanScanPage"; pageId: string }
  | { type: "applyAllCleanScanPages" }
  | { type: "rejectCleanScanPage"; pageId: string }
  | { type: "undoCleanScanReview" };

type CleanScanPageCardProps = {
  context: CleanScanPageContext;
  failure: CleanScanFailure | undefined;
  geometry: CleanScanGeometry | undefined;
  onAction: (action: CleanScanReviewAction) => void;
  page: CleanScanPageReview;
};

const CleanScanPageCard = ({
  context: { pageNumber, rotation },
  failure,
  geometry,
  onAction,
  page,
}: CleanScanPageCardProps) => {
  const t = useTranslations("workspaces.pdf.pageEditor");
  const tScan = useTranslations("workspaces.pdf.pageEditor.cleanScan");
  const body = (() => {
    switch (page.type) {
      case "pending":
        return failure ? (
          <p className="text-destructive text-xs" role="alert">
            {tScan(FAILURE_KEYS[failure.reason])}
          </p>
        ) : (
          <div className="bg-muted flex aspect-[3/4] items-center justify-center rounded-sm">
            <Loader label={tScan("cleaning")} size="sm" />
          </div>
        );
      case "unrecognized":
        return (
          <p className="text-muted-foreground text-xs">
            {tScan(unrecognizedReasonKey(page.reason))}
          </p>
        );
      case "preview":
      case "applied":
      case "rejected":
        return geometry ? (
          <CleanScanPreview
            geometry={geometry}
            image={page.scan.image}
            label={tScan("preview", { number: pageNumber })}
            muted={page.type === "rejected"}
            rotation={rotation}
          />
        ) : (
          panic(`Cleaned page has no geometry: ${page.pageId}`)
        );
      default:
        return panic("Unhandled clean scan page", page satisfies never);
    }
  })();
  return (
    <li className="bg-card flex min-w-0 flex-col gap-2 rounded-lg border p-2 shadow-xs">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="font-medium">
          {t("pageNumber", { number: pageNumber })}
        </span>
        {page.type === "applied" && (
          <span className="text-primary flex items-center gap-1">
            <CheckIcon className="size-3.5" />
            {tScan("applied")}
          </span>
        )}
        {page.type === "rejected" && (
          <span className="text-muted-foreground">{tScan("rejected")}</span>
        )}
      </div>
      {body}
      {page.type === "preview" && (
        <div className="flex gap-1">
          <Button
            aria-label={tScan("applyPage", { number: pageNumber })}
            className="flex-1"
            onClick={() =>
              onAction({ type: "applyCleanScanPage", pageId: page.pageId })
            }
            size="sm"
          >
            {tScan("apply")}
          </Button>
          <Button
            aria-label={tScan("rejectPage", { number: pageNumber })}
            className="flex-1"
            onClick={() =>
              onAction({ type: "rejectCleanScanPage", pageId: page.pageId })
            }
            size="sm"
            variant="outline"
          >
            {tScan("reject")}
          </Button>
        </div>
      )}
    </li>
  );
};

type PageOrganizerCleanScanProps = {
  /** Page number and rotation of each page under review, by page id. */
  pages: ReadonlyMap<string, CleanScanPageContext>;
  session: CleanScanSession;
  onAction: (action: CleanScanReviewAction) => void;
  onCommit: () => void;
  onOptionsChange: (options: ScanOptions) => void;
};

/**
 * Review a clean-scan run page by page: each page shows its cleaned preview,
 * why it was left alone, or why cleaning failed. Applied pages reach the
 * document only through "Use cleaned pages"; closing discards the review.
 */
export const PageOrganizerCleanScan = ({
  pages,
  session,
  onAction,
  onCommit,
  onOptionsChange,
}: PageOrganizerCleanScanProps) => {
  const tCommon = useTranslations("common");
  const tScan = useTranslations("workspaces.pdf.pageEditor.cleanScan");
  const format = useFormatter();
  const outputId = useId();
  const contentCropId = useId();
  const deskewId = useId();
  const { options, review } = session;
  const failureByPage = new Map(
    session.failures.map((failure) => [failure.pageId, failure]),
  );
  const finished = review.pages.filter(
    (page) => page.type !== "pending" || failureByPage.has(page.pageId),
  ).length;
  const appliedCount = review.pages.filter(
    (page) => page.type === "applied",
  ).length;
  const hasPreview = review.pages.some((page) => page.type === "preview");

  return (
    <>
      <DialogHeader>
        <DialogTitle>{tScan("heading")}</DialogTitle>
        <DialogDescription>
          {tScan("description", { count: review.pages.length })}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="space-y-4">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="flex items-center gap-2">
            <Label htmlFor={outputId}>{tScan("output")}</Label>
            <Select
              onValueChange={(value) => {
                if (isOutput(value) && value !== options.output) {
                  onOptionsChange({ ...options, output: value });
                }
              }}
              value={options.output}
            >
              <SelectTrigger className="w-auto" id={outputId} size="sm">
                <SelectValue>
                  {tScan(OUTPUT_LABEL_KEYS[options.output])}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                <SelectItem value="grayscale">
                  {tScan(OUTPUT_LABEL_KEYS.grayscale)}
                </SelectItem>
                <SelectItem value="binary">
                  {tScan(OUTPUT_LABEL_KEYS.binary)}
                </SelectItem>
              </SelectPopup>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <Switch
              checked={options.contentCrop === "on"}
              id={contentCropId}
              onCheckedChange={(checked) =>
                onOptionsChange({
                  ...options,
                  contentCrop: checked ? "on" : "off",
                })
              }
            />
            <Label htmlFor={contentCropId}>{tScan("contentCrop")}</Label>
          </div>
          <div className="flex items-center gap-2">
            <Switch
              checked={options.deskew === "on"}
              id={deskewId}
              onCheckedChange={(checked) =>
                onOptionsChange({ ...options, deskew: checked ? "on" : "off" })
              }
            />
            <Label htmlFor={deskewId}>{tScan("deskew")}</Label>
          </div>
        </div>
        <p aria-live="polite" className="text-muted-foreground text-xs">
          {tScan("progress", {
            done: format.number(finished),
            total: format.number(review.pages.length),
          })}
        </p>
        <ol className="grid grid-cols-[repeat(auto-fill,minmax(12rem,1fr))] gap-3">
          {review.pages.map((page) => {
            const context = pages.get(page.pageId);
            if (!context) {
              return panic(`Reviewed page is not in the plan: ${page.pageId}`);
            }
            return (
              <CleanScanPageCard
                context={context}
                failure={failureByPage.get(page.pageId)}
                geometry={session.geometry.get(page.pageId)}
                key={page.pageId}
                onAction={onAction}
                page={page}
              />
            );
          })}
        </ol>
      </DialogPanel>
      <DialogFooter>
        <Button
          className="sm:me-auto"
          disabled={review.past.length === 0}
          onClick={() => onAction({ type: "undoCleanScanReview" })}
          size="sm"
          variant="ghost"
        >
          <Undo2Icon />
          {tCommon("undo")}
        </Button>
        <Button
          disabled={!hasPreview}
          onClick={() => onAction({ type: "applyAllCleanScanPages" })}
          size="sm"
          variant="outline"
        >
          {tScan("applyAll")}
        </Button>
        <DialogClose render={<Button size="sm" variant="ghost" />}>
          {tCommon("cancel")}
        </DialogClose>
        <Button disabled={appliedCount === 0} onClick={onCommit} size="sm">
          {tScan("use", { count: appliedCount })}
        </Button>
      </DialogFooter>
    </>
  );
};
