/**
 * Table Properties Dialog — width type, width value, alignment.
 */

import { useCallback, useEffect, useState } from "react";

import {
  Dialog,
  DialogPortal,
  DialogBackdrop,
  DialogPopup,
  DialogTitle,
  DialogClose,
} from "@stll/ui/components/dialog";

export type TableProperties = {
  width?: number | null;
  widthType?: string | null;
  justification?: "left" | "center" | "right" | null;
};

export type TablePropertiesDialogProps = {
  isOpen: boolean;
  onClose: () => void;
  onApply: (props: TableProperties) => void;
  currentProps?: {
    width?: number;
    widthType?: string;
    justification?: string;
  };
};

export function TablePropertiesDialog({
  isOpen,
  onClose,
  onApply,
  currentProps,
}: TablePropertiesDialogProps) {
  const [width, setWidth] = useState(currentProps?.width ?? 0);
  const [widthType, setWidthType] = useState(currentProps?.widthType ?? "auto");
  const [justification, setJustification] = useState(
    currentProps?.justification ?? "left",
  );

  useEffect(() => {
    if (isOpen) {
      setWidth(currentProps?.width ?? 0);
      setWidthType(currentProps?.widthType ?? "auto");
      setJustification(currentProps?.justification ?? "left");
    }
  }, [isOpen, currentProps]);

  const handleApply = useCallback(() => {
    const justifValue =
      justification === "left" ||
      justification === "center" ||
      justification === "right"
        ? justification
        : ("left" as const);
    const props: TableProperties = {
      justification: justifValue,
    };
    if (widthType === "auto") {
      props.width = null;
      props.widthType = "auto";
    } else {
      props.width = width;
      props.widthType = widthType;
    }
    onApply(props);
    onClose();
  }, [width, widthType, justification, onApply, onClose]);

  const labelCls = "w-20 text-muted-foreground text-[13px]";
  const inputCls =
    "border-input bg-background text-foreground flex-1 rounded border px-2 py-1.5 text-[13px] outline-none";

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
        <DialogPopup className="bg-popover fixed start-1/2 top-1/2 z-[10001] w-full max-w-[440px] min-w-[360px] -translate-x-1/2 -translate-y-1/2 rounded-lg border shadow-xl">
          <DialogTitle className="border-b px-5 py-3 text-base font-semibold">
            Table Properties
          </DialogTitle>

          <div className="flex flex-col gap-3 px-5 py-4">
            <div className="flex items-center gap-3">
              <label className={labelCls} htmlFor="tp-width-type">
                Width type
              </label>
              <select
                className={inputCls}
                id="tp-width-type"
                onChange={(e) => setWidthType(e.target.value)}
                value={widthType}
              >
                <option value="auto">Auto</option>
                <option value="dxa">Fixed (twips)</option>
                <option value="pct">Percentage</option>
              </select>
            </div>

            {widthType !== "auto" && (
              <div className="flex items-center gap-3">
                <label className={labelCls} htmlFor="tp-width">
                  Width
                </label>
                <input
                  className={inputCls}
                  id="tp-width"
                  min={0}
                  onChange={(e) => setWidth(Number(e.target.value) || 0)}
                  step={widthType === "pct" ? 5 : 100}
                  type="number"
                  value={width}
                />
                <span className="text-muted-foreground text-[11px]">
                  {widthType === "pct" ? "(50ths of %)" : "tw"}
                </span>
              </div>
            )}

            <div className="flex items-center gap-3">
              <label className={labelCls} htmlFor="tp-align">
                Alignment
              </label>
              <select
                className={inputCls}
                id="tp-align"
                onChange={(e) => setJustification(e.target.value)}
                value={justification}
              >
                <option value="left">Left</option>
                <option value="center">Center</option>
                <option value="right">Right</option>
              </select>
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
