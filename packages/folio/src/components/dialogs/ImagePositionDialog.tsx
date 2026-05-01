/**
 * Image Position Dialog
 *
 * Modal for editing image positioning settings:
 * - Horizontal: alignment or offset, relative to page/column/margin/paragraph
 * - Vertical: alignment or offset, relative to page/margin/paragraph/line
 * - Distance from text (top/bottom/left/right)
 */

import { useEffect, useState } from "react";

import {
  Dialog,
  DialogPortal,
  DialogBackdrop,
  DialogPopup,
  DialogTitle,
  DialogClose,
} from "@stll/ui/components/dialog";

// ============================================================================
// TYPES
// ============================================================================

export type ImagePositionData = {
  horizontal?: {
    relativeTo?: string;
    posOffset?: number;
    align?: string;
  };
  vertical?: {
    relativeTo?: string;
    posOffset?: number;
    align?: string;
  };
  distTop?: number;
  distBottom?: number;
  distLeft?: number;
  distRight?: number;
};

export type ImagePositionDialogProps = {
  isOpen: boolean;
  onClose: () => void;
  onApply: (data: ImagePositionData) => void;
  currentData?: ImagePositionData;
};

// ============================================================================
// COMPONENT
// ============================================================================

export function ImagePositionDialog({
  isOpen,
  onClose,
  onApply,
  currentData,
}: ImagePositionDialogProps) {
  const [hMode, setHMode] = useState<"align" | "offset">("align");
  const [hAlign, setHAlign] = useState("center");
  const [hRelativeTo, setHRelativeTo] = useState("column");
  const [hOffset, setHOffset] = useState(0);

  const [vMode, setVMode] = useState<"align" | "offset">("align");
  const [vAlign, setVAlign] = useState("top");
  const [vRelativeTo, setVRelativeTo] = useState("paragraph");
  const [vOffset, setVOffset] = useState(0);

  const [distTop, setDistTop] = useState(0);
  const [distBottom, setDistBottom] = useState(0);
  const [distLeft, setDistLeft] = useState(0);
  const [distRight, setDistRight] = useState(0);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const h = currentData?.horizontal;
    const v = currentData?.vertical;
    if (h?.align) {
      setHMode("align");
      setHAlign(h.align);
    } else if (h?.posOffset !== null && h?.posOffset !== undefined) {
      setHMode("offset");
      setHOffset(h.posOffset);
    }
    if (h?.relativeTo) {
      setHRelativeTo(h.relativeTo);
    }

    if (v?.align) {
      setVMode("align");
      setVAlign(v.align);
    } else if (v?.posOffset !== null && v?.posOffset !== undefined) {
      setVMode("offset");
      setVOffset(v.posOffset);
    }
    if (v?.relativeTo) {
      setVRelativeTo(v.relativeTo);
    }

    setDistTop(currentData?.distTop ?? 0);
    setDistBottom(currentData?.distBottom ?? 0);
    setDistLeft(currentData?.distLeft ?? 0);
    setDistRight(currentData?.distRight ?? 0);
  }, [isOpen, currentData]);

  const handleApply = () => {
    const data: ImagePositionData = {};
    data.horizontal = {
      relativeTo: hRelativeTo,
      ...(hMode === "align" ? { align: hAlign } : { posOffset: hOffset }),
    };
    data.vertical = {
      relativeTo: vRelativeTo,
      ...(vMode === "align" ? { align: vAlign } : { posOffset: vOffset }),
    };
    data.distTop = distTop;
    data.distBottom = distBottom;
    data.distLeft = distLeft;
    data.distRight = distRight;
    onApply(data);
    onClose();
  };

  const labelCls = "w-[75px] text-muted-foreground text-xs";
  const inputCls =
    "border-input bg-background text-foreground flex-1 rounded border px-1.5 py-1 text-xs outline-none";
  const sectionLabelCls = "text-foreground text-[13px] font-semibold";
  const distLabelCls = "w-[45px] text-muted-foreground text-xs";

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <DialogPortal>
        <DialogBackdrop className="fixed inset-0 z-[10000] bg-black/50" />
        <DialogPopup className="bg-popover fixed start-1/2 top-1/2 z-[10001] w-full max-w-[480px] min-w-[400px] -translate-x-1/2 -translate-y-1/2 rounded-lg border shadow-xl">
          <DialogTitle className="border-b px-5 py-3 text-base font-semibold">
            Image Position
          </DialogTitle>

          <div className="flex flex-col gap-4 px-5 py-4">
            {/* Horizontal positioning */}
            <div className="flex flex-col gap-2">
              <div className={sectionLabelCls}>Horizontal</div>
              <div className="flex items-center gap-2">
                <label className={labelCls} htmlFor="img-pos-h-mode">
                  Position
                </label>
                <select
                  id="img-pos-h-mode"
                  className={inputCls}
                  value={hMode}
                  onChange={(e) =>
                    setHMode(e.target.value as "align" | "offset")
                  }
                >
                  <option value="align">Alignment</option>
                  <option value="offset">Offset</option>
                </select>
              </div>
              {hMode === "align" ? (
                <div className="flex items-center gap-2">
                  <label className={labelCls} htmlFor="img-pos-h-align">
                    Align
                  </label>
                  <select
                    id="img-pos-h-align"
                    className={inputCls}
                    value={hAlign}
                    onChange={(e) => setHAlign(e.target.value)}
                  >
                    <option value="left">Left</option>
                    <option value="center">Center</option>
                    <option value="right">Right</option>
                  </select>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <label className={labelCls} htmlFor="img-pos-h-offset">
                    Offset (px)
                  </label>
                  <input
                    id="img-pos-h-offset"
                    type="number"
                    className={inputCls}
                    value={hOffset}
                    onChange={(e) => setHOffset(Number(e.target.value) || 0)}
                  />
                </div>
              )}
              <div className="flex items-center gap-2">
                <label className={labelCls} htmlFor="img-pos-h-rel">
                  Relative to
                </label>
                <select
                  id="img-pos-h-rel"
                  className={inputCls}
                  value={hRelativeTo}
                  onChange={(e) => setHRelativeTo(e.target.value)}
                >
                  <option value="page">Page</option>
                  <option value="column">Column</option>
                  <option value="margin">Margin</option>
                  <option value="character">Character</option>
                </select>
              </div>
            </div>

            {/* Vertical positioning */}
            <div className="flex flex-col gap-2">
              <div className={sectionLabelCls}>Vertical</div>
              <div className="flex items-center gap-2">
                <label className={labelCls} htmlFor="img-pos-v-mode">
                  Position
                </label>
                <select
                  id="img-pos-v-mode"
                  className={inputCls}
                  value={vMode}
                  onChange={(e) =>
                    setVMode(e.target.value as "align" | "offset")
                  }
                >
                  <option value="align">Alignment</option>
                  <option value="offset">Offset</option>
                </select>
              </div>
              {vMode === "align" ? (
                <div className="flex items-center gap-2">
                  <label className={labelCls} htmlFor="img-pos-v-align">
                    Align
                  </label>
                  <select
                    id="img-pos-v-align"
                    className={inputCls}
                    value={vAlign}
                    onChange={(e) => setVAlign(e.target.value)}
                  >
                    <option value="top">Top</option>
                    <option value="center">Center</option>
                    <option value="bottom">Bottom</option>
                  </select>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <label className={labelCls} htmlFor="img-pos-v-offset">
                    Offset (px)
                  </label>
                  <input
                    id="img-pos-v-offset"
                    type="number"
                    className={inputCls}
                    value={vOffset}
                    onChange={(e) => setVOffset(Number(e.target.value) || 0)}
                  />
                </div>
              )}
              <div className="flex items-center gap-2">
                <label className={labelCls} htmlFor="img-pos-v-rel">
                  Relative to
                </label>
                <select
                  id="img-pos-v-rel"
                  className={inputCls}
                  value={vRelativeTo}
                  onChange={(e) => setVRelativeTo(e.target.value)}
                >
                  <option value="page">Page</option>
                  <option value="margin">Margin</option>
                  <option value="paragraph">Paragraph</option>
                  <option value="line">Line</option>
                </select>
              </div>
            </div>

            {/* Distance from text */}
            <div className="flex flex-col gap-2">
              <div className={sectionLabelCls}>Distance from text (px)</div>
              <div className="grid grid-cols-2 gap-2">
                <div className="flex items-center gap-2">
                  <label className={distLabelCls} htmlFor="img-pos-dist-top">
                    Top
                  </label>
                  <input
                    id="img-pos-dist-top"
                    type="number"
                    className={inputCls}
                    min={0}
                    value={distTop}
                    onChange={(e) => setDistTop(Number(e.target.value) || 0)}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <label className={distLabelCls} htmlFor="img-pos-dist-bottom">
                    Bottom
                  </label>
                  <input
                    id="img-pos-dist-bottom"
                    type="number"
                    className={inputCls}
                    min={0}
                    value={distBottom}
                    onChange={(e) => setDistBottom(Number(e.target.value) || 0)}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <label className={distLabelCls} htmlFor="img-pos-dist-left">
                    Left
                  </label>
                  <input
                    id="img-pos-dist-left"
                    type="number"
                    className={inputCls}
                    min={0}
                    value={distLeft}
                    onChange={(e) => setDistLeft(Number(e.target.value) || 0)}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <label className={distLabelCls} htmlFor="img-pos-dist-right">
                    Right
                  </label>
                  <input
                    id="img-pos-dist-right"
                    type="number"
                    className={inputCls}
                    min={0}
                    value={distRight}
                    onChange={(e) => setDistRight(Number(e.target.value) || 0)}
                  />
                </div>
              </div>
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
