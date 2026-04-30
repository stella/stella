/**
 * Image Properties Dialog
 *
 * Modal for editing image properties:
 * - Alt text for accessibility
 * - Border/outline style, color, and width
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

export type ImagePropertiesData = {
  alt?: string;
  borderWidth?: number;
  borderColor?: string;
  borderStyle?: string;
};

export type ImagePropertiesDialogProps = {
  isOpen: boolean;
  onClose: () => void;
  onApply: (data: ImagePropertiesData) => void;
  currentData?: ImagePropertiesData;
};

// ============================================================================
// COMPONENT
// ============================================================================

export function ImagePropertiesDialog({
  isOpen,
  onClose,
  onApply,
  currentData,
}: ImagePropertiesDialogProps) {
  const [alt, setAlt] = useState("");
  const [borderWidth, setBorderWidth] = useState(0);
  const [borderColor, setBorderColor] = useState("#000000");
  const [borderStyle, setBorderStyle] = useState("solid");

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    setAlt(currentData?.alt ?? "");
    setBorderWidth(currentData?.borderWidth ?? 0);
    setBorderColor(currentData?.borderColor ?? "#000000");
    setBorderStyle(currentData?.borderStyle ?? "solid");
  }, [isOpen, currentData]);

  const handleApply = () => {
    onApply({
      ...(alt ? { alt } : {}),
      ...(borderWidth > 0 ? { borderWidth, borderColor, borderStyle } : {}),
    });
    onClose();
  };

  const labelCls = "w-[60px] text-muted-foreground text-xs";
  const inputCls =
    "border-input bg-background text-foreground flex-1 rounded border px-1.5 py-1 text-xs outline-none";
  const sectionLabelCls = "text-foreground text-[13px] font-semibold";

  return (
    <Dialog open={isOpen} onOpenChange={(o) => !o && onClose()}>
      <DialogPortal>
        <DialogBackdrop className="fixed inset-0 z-[10000] bg-black/50" />
        <DialogPopup className="bg-popover fixed start-1/2 top-1/2 z-[10001] w-full max-w-[440px] min-w-[380px] -translate-x-1/2 -translate-y-1/2 rounded-lg border shadow-xl">
          <DialogTitle className="border-b px-5 py-3 text-base font-semibold">
            Image Properties
          </DialogTitle>

          <div className="flex flex-col gap-4 px-5 py-4">
            {/* Alt Text */}
            <div className="flex flex-col gap-2">
              <div className={sectionLabelCls}>Alt Text</div>
              <textarea
                className="border-input bg-background text-foreground font-inherit min-h-[60px] resize-y rounded border px-1.5 py-1 text-xs outline-none"
                value={alt}
                onChange={(e) => setAlt(e.target.value)}
                placeholder="Describe this image for accessibility..."
              />
            </div>

            {/* Border / Outline */}
            <div className="flex flex-col gap-2">
              <div className={sectionLabelCls}>Border</div>
              <div className="flex items-center gap-2">
                <label htmlFor="img-border-width" className={labelCls}>
                  Width
                </label>
                <input
                  id="img-border-width"
                  type="number"
                  className={`${inputCls} max-w-[80px]`}
                  min={0}
                  max={20}
                  step={0.5}
                  value={borderWidth}
                  onChange={(e) => setBorderWidth(Number(e.target.value) || 0)}
                />
                <span className="text-muted-foreground text-xs">px</span>
              </div>
              <div className="flex items-center gap-2">
                <label htmlFor="img-border-style" className={labelCls}>
                  Style
                </label>
                <select
                  id="img-border-style"
                  className={inputCls}
                  value={borderStyle}
                  onChange={(e) => setBorderStyle(e.target.value)}
                >
                  <option value="solid">Solid</option>
                  <option value="dashed">Dashed</option>
                  <option value="dotted">Dotted</option>
                  <option value="double">Double</option>
                  <option value="groove">Groove</option>
                  <option value="ridge">Ridge</option>
                  <option value="inset">Inset</option>
                  <option value="outset">Outset</option>
                </select>
              </div>
              <div className="flex items-center gap-2">
                <label htmlFor="img-border-color" className={labelCls}>
                  Color
                </label>
                <input
                  id="img-border-color"
                  type="color"
                  value={borderColor}
                  onChange={(e) => setBorderColor(e.target.value)}
                  className="border-input h-6 w-8 cursor-pointer rounded border p-0"
                />
                <input
                  type="text"
                  className={`${inputCls} max-w-[90px]`}
                  value={borderColor}
                  onChange={(e) => setBorderColor(e.target.value)}
                />
              </div>
              {borderWidth > 0 && (
                <div
                  className="text-muted-foreground mt-1 rounded p-2 text-center text-[11px]"
                  style={{
                    border: `${borderWidth}px ${borderStyle} ${borderColor}`,
                  }}
                >
                  Preview
                </div>
              )}
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
