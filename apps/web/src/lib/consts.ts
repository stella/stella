// prettier-ignore
export const DOCX_MIME =
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document" as const;

export const PDF_MIME = "application/pdf" as const;

export const STALE_TIME = {
  INFINITE: Number.POSITIVE_INFINITY,
  FIVE: {
    MINUTES: 5 * 60 * 1000,
  },
  FIVETEEN: {
    MINUTES: 15 * 60 * 1000,
  },
};
