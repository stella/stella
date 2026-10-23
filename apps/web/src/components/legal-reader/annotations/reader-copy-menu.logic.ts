export type ReaderCopyMenuBox = {
  bottom?: number;
  left: number;
  opensUp: boolean;
  top?: number;
  width: number;
};

/** Aligns the copy menu to the visible horizontal extent of its toolbar. */
export const readerCopyMenuBox = ({
  bar,
  menuHeight,
  viewport,
}: {
  bar: Pick<DOMRect, "bottom" | "left" | "top" | "width">;
  menuHeight: number;
  viewport: { height: number; width: number };
}): ReaderCopyMenuBox => {
  const left = Math.max(0, bar.left);
  const opensUp =
    bar.bottom + menuHeight > viewport.height &&
    bar.top >= viewport.height - bar.bottom;
  return {
    ...(opensUp
      ? { bottom: viewport.height - bar.top + 4 }
      : { top: bar.bottom + 4 }),
    left,
    opensUp,
    width: Math.max(0, Math.min(bar.width, viewport.width - left)),
  };
};
