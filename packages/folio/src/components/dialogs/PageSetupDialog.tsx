/**
 * Page Setup Dialog
 *
 * Modal for editing page layout properties:
 * - Page size (Letter, A4, Legal, etc.)
 * - Orientation (portrait/landscape)
 * - Margins (top, bottom, left, right) in inches
 */

import { useEffect, useState } from "react";

import {
  Dialog,
  DialogPortal,
  DialogBackdrop,
  DialogPopup,
  DialogTitle,
  DialogClose,
} from "@stella/ui/components/dialog";

import type { SectionProperties } from "../../core/types/document";
import { TWIPS_PER_INCH } from "../../core/utils/units";

/** Common page sizes in twips (width x height in portrait orientation) */
const PAGE_SIZES = [
  { label: 'Letter (8.5" × 11")', width: 12_240, height: 15_840 },
  { label: 'A4 (8.27" × 11.69")', width: 11_906, height: 16_838 },
  { label: 'Legal (8.5" × 14")', width: 12_240, height: 20_160 },
  { label: 'A3 (11.69" × 16.54")', width: 16_838, height: 23_811 },
  { label: 'A5 (5.83" × 8.27")', width: 8391, height: 11_906 },
  { label: 'B5 (6.93" × 9.84")', width: 9979, height: 14_175 },
  { label: 'Executive (7.25" × 10.5")', width: 10_440, height: 15_120 },
] as const;

// ============================================================================
// TYPES
// ============================================================================

export type PageSetupDialogProps = {
  isOpen: boolean;
  onClose: () => void;
  onApply: (props: Partial<SectionProperties>) => void;
  currentProps?: SectionProperties;
};

// ============================================================================
// HELPERS
// ============================================================================

function twipsToInches(twips: number): number {
  return Math.round((twips / TWIPS_PER_INCH) * 100) / 100;
}

function inchesToTwips(inches: number): number {
  return Math.round(inches * TWIPS_PER_INCH);
}

/** Find matching page size preset, ignoring orientation */
function findPageSizeIndex(w: number, h: number): number {
  // Normalize to portrait (smaller dimension = width)
  const pw = Math.min(w, h);
  const ph = Math.max(w, h);
  return PAGE_SIZES.findIndex(
    (s) => Math.abs(s.width - pw) < 20 && Math.abs(s.height - ph) < 20,
  );
}

// ============================================================================
// COMPONENT
// ============================================================================

// Default Word values (Letter, 1" margins)
const DEFAULT_WIDTH = 12_240;
const DEFAULT_HEIGHT = 15_840;
const DEFAULT_MARGIN = 1440;

export function PageSetupDialog({
  isOpen,
  onClose,
  onApply,
  currentProps,
}: PageSetupDialogProps) {
  const [pageWidth, setPageWidth] = useState(DEFAULT_WIDTH);
  const [pageHeight, setPageHeight] = useState(DEFAULT_HEIGHT);
  const [orientation, setOrientation] = useState<"portrait" | "landscape">(
    "portrait",
  );
  const [marginTop, setMarginTop] = useState(DEFAULT_MARGIN);
  const [marginBottom, setMarginBottom] = useState(DEFAULT_MARGIN);
  const [marginLeft, setMarginLeft] = useState(DEFAULT_MARGIN);
  const [marginRight, setMarginRight] = useState(DEFAULT_MARGIN);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const w = currentProps?.pageWidth || DEFAULT_WIDTH;
    const h = currentProps?.pageHeight || DEFAULT_HEIGHT;
    const orient =
      currentProps?.orientation || (w > h ? "landscape" : "portrait");
    setPageWidth(w);
    setPageHeight(h);
    setOrientation(orient);
    setMarginTop(currentProps?.marginTop ?? DEFAULT_MARGIN);
    setMarginBottom(currentProps?.marginBottom ?? DEFAULT_MARGIN);
    setMarginLeft(currentProps?.marginLeft ?? DEFAULT_MARGIN);
    setMarginRight(currentProps?.marginRight ?? DEFAULT_MARGIN);
  }, [isOpen, currentProps]);

  const handlePageSizeChange = (index: number) => {
    if (index < 0) {
      return;
    }
    const size = PAGE_SIZES[index];
    if (!size) {
      return;
    }
    if (orientation === "landscape") {
      setPageWidth(size.height);
      setPageHeight(size.width);
    } else {
      setPageWidth(size.width);
      setPageHeight(size.height);
    }
  };

  const handleOrientationChange = (
    newOrientation: "portrait" | "landscape",
  ) => {
    if (newOrientation === orientation) {
      return;
    }
    setOrientation(newOrientation);
    // Swap width and height
    setPageWidth(pageHeight);
    setPageHeight(pageWidth);
  };

  const handleApply = () => {
    onApply({
      pageWidth,
      pageHeight,
      orientation,
      marginTop,
      marginBottom,
      marginLeft,
      marginRight,
    });
    onClose();
  };

  const sizeIndex = findPageSizeIndex(pageWidth, pageHeight);

  const labelCls = "w-20 text-muted-foreground text-[13px]";
  const inputCls =
    "border-input bg-background text-foreground flex-1 rounded border px-2 py-1.5 text-[13px] outline-none";
  const sectionLabelCls =
    "text-muted-foreground text-xs font-semibold uppercase tracking-wide";

  return (
    <Dialog open={isOpen} onOpenChange={(o) => !o && onClose()}>
      <DialogPortal>
        <DialogBackdrop className="fixed inset-0 z-[10000] bg-black/50" />
        <DialogPopup className="bg-popover fixed start-1/2 top-1/2 z-[10001] w-full max-w-[480px] min-w-[400px] -translate-x-1/2 -translate-y-1/2 rounded-lg border shadow-xl">
          <DialogTitle className="border-b px-5 py-3 text-base font-semibold">
            Page Setup
          </DialogTitle>

          <div className="flex flex-col gap-3.5 px-5 py-4">
            {/* Page size section */}
            <div className={sectionLabelCls}>Page Size</div>

            <div className="flex items-center gap-3">
              <label htmlFor="ps-size" className={labelCls}>
                Size
              </label>
              <select
                id="ps-size"
                className={inputCls}
                value={sizeIndex}
                onChange={(e) => handlePageSizeChange(Number(e.target.value))}
              >
                {PAGE_SIZES.map((size, i) => (
                  <option key={size.label} value={i}>
                    {size.label}
                  </option>
                ))}
                {sizeIndex < 0 && <option value={-1}>Custom</option>}
              </select>
            </div>

            <div className="flex items-center gap-3">
              <label htmlFor="ps-orientation" className={labelCls}>
                Orientation
              </label>
              <select
                id="ps-orientation"
                className={inputCls}
                value={orientation}
                onChange={(e) =>
                  handleOrientationChange(
                    e.target.value as "portrait" | "landscape",
                  )
                }
              >
                <option value="portrait">Portrait</option>
                <option value="landscape">Landscape</option>
              </select>
            </div>

            {/* Margins section */}
            <div className={`${sectionLabelCls} mt-1`}>Margins</div>

            <div className="flex items-center gap-3">
              <label htmlFor="ps-margin-top" className={labelCls}>
                Top
              </label>
              <input
                id="ps-margin-top"
                type="number"
                className={inputCls}
                min={0}
                max={10}
                step={0.1}
                value={twipsToInches(marginTop)}
                onChange={(e) =>
                  setMarginTop(inchesToTwips(Number(e.target.value) || 0))
                }
              />
              <span className="text-muted-foreground w-4 text-[11px]">in</span>
            </div>

            <div className="flex items-center gap-3">
              <label htmlFor="ps-margin-bottom" className={labelCls}>
                Bottom
              </label>
              <input
                id="ps-margin-bottom"
                type="number"
                className={inputCls}
                min={0}
                max={10}
                step={0.1}
                value={twipsToInches(marginBottom)}
                onChange={(e) =>
                  setMarginBottom(inchesToTwips(Number(e.target.value) || 0))
                }
              />
              <span className="text-muted-foreground w-4 text-[11px]">in</span>
            </div>

            <div className="flex items-center gap-3">
              <label htmlFor="ps-margin-left" className={labelCls}>
                Left
              </label>
              <input
                id="ps-margin-left"
                type="number"
                className={inputCls}
                min={0}
                max={10}
                step={0.1}
                value={twipsToInches(marginLeft)}
                onChange={(e) =>
                  setMarginLeft(inchesToTwips(Number(e.target.value) || 0))
                }
              />
              <span className="text-muted-foreground w-4 text-[11px]">in</span>
            </div>

            <div className="flex items-center gap-3">
              <label htmlFor="ps-margin-right" className={labelCls}>
                Right
              </label>
              <input
                id="ps-margin-right"
                type="number"
                className={inputCls}
                min={0}
                max={10}
                step={0.1}
                value={twipsToInches(marginRight)}
                onChange={(e) =>
                  setMarginRight(inchesToTwips(Number(e.target.value) || 0))
                }
              />
              <span className="text-muted-foreground w-4 text-[11px]">in</span>
            </div>
          </div>

          <div className="flex justify-end gap-2 border-t px-5 py-3">
            <DialogClose className="border-input rounded border px-4 py-1.5 text-[13px]">
              Cancel
            </DialogClose>
            <button
              className="bg-primary text-primary-foreground rounded px-4 py-1.5 text-[13px] font-medium"
              onClick={handleApply}
              type="button"
            >
              Apply
            </button>
          </div>
        </DialogPopup>
      </DialogPortal>
    </Dialog>
  );
}
export default PageSetupDialog;
