// prettier-ignore
export const DOCX_MIME =
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document" as const;

export const PDF_MIME = "application/pdf" as const;

/**
 * Shared layout heights so rows stay vertically aligned
 * across the main content area and the right panel.
 * Must match the chrome topbar (`h-12`) so right-side
 * sub-screens line up with the matter header.
 */
export const TOOLBAR_ROW_HEIGHT = "h-12" as const;
export const TOOLBAR_ROW_MIN_HEIGHT = "min-h-12" as const;
export const TOOLBAR_ROW_HEIGHT_PX = 48 as const;
export const SIDE_RAIL_WIDTH = "w-12" as const;
export const SIDE_RAIL_ICON_BUTTON_SIZE = "size-8" as const;

export const STALE_TIME = {
  INFINITE: Number.POSITIVE_INFINITY,
  FIVE: {
    MINUTES: 5 * 60 * 1000,
  },
  FIVETEEN: {
    MINUTES: 15 * 60 * 1000,
  },
};
