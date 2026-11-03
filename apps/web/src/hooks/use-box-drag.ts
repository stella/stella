import { useRef } from "react";
import type { PointerEvent } from "react";

export type BoxDragAdjustment<Box, Mode> = {
  box: Box;
  delta: { x: number; y: number };
  mode: Mode;
};

type BoxDragOptions<Box, Mode> = {
  adjust: (adjustment: BoxDragAdjustment<Box, Mode>) => Box;
  box: Box;
  onChange: (box: Box) => void;
};

type Drag<Box, Mode> = {
  box: Box;
  mode: Mode;
  origin: { x: number; y: number };
  pointerId: number;
  surface: { height: number; width: number };
};

type BoxDragStartOptions<Box, Mode> = {
  /** The box the gesture starts from, when it is not the rendered one. */
  from?: Box | undefined;
  mode: Mode;
  surface: HTMLElement;
};

/** Pointer capture and page-relative deltas, with geometry owned by the caller. */
export const useBoxDrag = <Box, Mode>({
  adjust,
  box,
  onChange,
}: BoxDragOptions<Box, Mode>) => {
  const dragRef = useRef<Drag<Box, Mode> | null>(null);

  const endDrag = (event: PointerEvent<HTMLElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = null;
    }
  };

  const startDrag = (
    event: PointerEvent<HTMLElement>,
    { from = box, mode, surface }: BoxDragStartOptions<Box, Mode>,
  ) => {
    if (event.button !== 0) {
      return;
    }
    const rect = surface.getBoundingClientRect();
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus({ preventScroll: true });
    dragRef.current = {
      box: from,
      mode,
      origin: { x: event.clientX, y: event.clientY },
      pointerId: event.pointerId,
      surface: { height: rect.height, width: rect.width },
    };
  };

  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (drag?.pointerId !== event.pointerId) {
      return;
    }
    onChange(
      adjust({
        box: drag.box,
        delta: {
          x:
            drag.surface.width > 0
              ? (event.clientX - drag.origin.x) / drag.surface.width
              : 0,
          y:
            drag.surface.height > 0
              ? (event.clientY - drag.origin.y) / drag.surface.height
              : 0,
        },
        mode: drag.mode,
      }),
    );
  };

  return {
    onLostPointerCapture: endDrag,
    onPointerCancel: endDrag,
    onPointerMove,
    onPointerUp: endDrag,
    startDrag,
  };
};
