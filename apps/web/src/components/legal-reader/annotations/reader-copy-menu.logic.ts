export type ReaderCopyMenuBox = {
  bottom?: number;
  left: number;
  opensUp: boolean;
  top?: number;
  width: number;
};

/**
 * Starts the copy menu at its toolbar's left edge, at least `menuWidth` wide
 * so the preview fits beside the options, and shifts it left to stay inside
 * the viewport.
 */
export const readerCopyMenuBox = ({
  bar,
  menuHeight,
  menuWidth,
  viewport,
}: {
  bar: Pick<DOMRect, "bottom" | "left" | "top" | "width">;
  menuHeight: number;
  menuWidth: number;
  viewport: { height: number; width: number };
}): ReaderCopyMenuBox => {
  const width = Math.min(Math.max(bar.width, menuWidth), viewport.width);
  const left = Math.max(0, Math.min(bar.left, viewport.width - width));
  const opensUp =
    bar.bottom + menuHeight > viewport.height &&
    bar.top >= viewport.height - bar.bottom;
  return {
    ...(opensUp
      ? { bottom: viewport.height - bar.top + 4 }
      : { top: bar.bottom + 4 }),
    left,
    opensUp,
    width,
  };
};
