export const PDF_SCALE_OFFSET_STEP = 0.2;
export const PDF_MIN_SCALE_OFFSET = -0.8;
export const PDF_MAX_SCALE_OFFSET = 2;

const PDF_PINCH_ZOOM_SENSITIVITY = 0.005;
const PDF_SCALE_OFFSET_PRECISION = 100;

type PDFWheelZoomEvent = Pick<WheelEvent, "ctrlKey" | "deltaY"> & {
  preventDefault: () => void;
};

export const getPDFScaleOffset = (
  currentScaleOffset: number,
  delta: number,
) => {
  const boundedOffset = Math.max(
    PDF_MIN_SCALE_OFFSET,
    Math.min(PDF_MAX_SCALE_OFFSET, currentScaleOffset + delta),
  );

  return (
    Math.round(boundedOffset * PDF_SCALE_OFFSET_PRECISION) /
    PDF_SCALE_OFFSET_PRECISION
  );
};

export const getPDFWheelZoomScaleOffset = (
  currentScaleOffset: number,
  deltaY: number,
) => {
  const delta = -deltaY * PDF_PINCH_ZOOM_SENSITIVITY;
  return getPDFScaleOffset(currentScaleOffset, delta);
};

export const consumePDFWheelZoomEvent = (
  event: PDFWheelZoomEvent,
  onWheelZoom: (deltaY: number) => void,
) => {
  if (!event.ctrlKey) {
    return false;
  }

  // Chrome exposes a trackpad pinch as a ctrl+wheel event. Consume it even
  // when the viewer is already at a zoom bound, otherwise the gesture leaks
  // through and starts zooming the whole browser page.
  event.preventDefault();
  onWheelZoom(event.deltaY);
  return true;
};
