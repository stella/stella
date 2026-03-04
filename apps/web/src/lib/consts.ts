// prettier-ignore
export const DOCX_MIME =
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document" as const;

export const PDF_MIME = "application/pdf" as const;

/**
 * Shared layout heights so rows stay vertically aligned
 * across the main content area and the right panel.
 */
export const TOOLBAR_ROW_HEIGHT = "h-10" as const;

export const STALE_TIME = {
  INFINITE: Number.POSITIVE_INFINITY,
  FIVE: {
    MINUTES: 5 * 60 * 1000,
  },
  FIVETEEN: {
    MINUTES: 15 * 60 * 1000,
  },
};
