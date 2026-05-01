export type ViewportCenterZoomAnchor = {
  offsetY: number;
  scaledY: number;
  zoom: number;
};

type CaptureViewportCenterZoomAnchorParams = {
  clientHeight: number;
  scrollTop: number;
  zoom: number;
};

type GetViewportCenterZoomAnchorForZoomChangeParams = {
  clientHeight: number;
  currentZoom: number;
  nextZoom: number;
  pendingAnchor: ViewportCenterZoomAnchor | null;
  scrollTop: number;
};

export const captureViewportCenterZoomAnchor = ({
  clientHeight,
  scrollTop,
  zoom,
}: CaptureViewportCenterZoomAnchorParams): ViewportCenterZoomAnchor => {
  const offsetY = clientHeight / 2;

  return {
    offsetY,
    scaledY: scrollTop + offsetY,
    zoom,
  };
};

export const getViewportCenterZoomAnchorForZoomChange = ({
  clientHeight,
  currentZoom,
  nextZoom,
  pendingAnchor,
  scrollTop,
}: GetViewportCenterZoomAnchorForZoomChangeParams) => {
  if (pendingAnchor?.zoom === nextZoom) {
    return null;
  }

  if (currentZoom === nextZoom) {
    return pendingAnchor;
  }

  if (pendingAnchor) {
    return pendingAnchor;
  }

  return captureViewportCenterZoomAnchor({
    clientHeight,
    scrollTop,
    zoom: currentZoom,
  });
};

export const getScrollTopForZoomAnchor = (
  anchor: ViewportCenterZoomAnchor,
  nextZoom: number,
) => {
  if (anchor.zoom <= 0 || nextZoom <= 0) {
    return anchor.scaledY - anchor.offsetY;
  }

  return anchor.scaledY * (nextZoom / anchor.zoom) - anchor.offsetY;
};
