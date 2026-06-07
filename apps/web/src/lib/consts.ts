// prettier-ignore
export const DOCX_MIME =
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document" as const;

export const PDF_MIME = "application/pdf" as const;
export const EML_MIME = "message/rfc822" as const;
export const MSG_MIME = "application/vnd.ms-outlook" as const;
export const MARKDOWN_MIME = "text/markdown" as const;

const EMAIL_MIME_TYPES = new Set<string>([EML_MIME, MSG_MIME]);
const EMAIL_EXTENSION_MIME_TYPES: Record<string, string> = {
  eml: EML_MIME,
  msg: MSG_MIME,
};
const MARKDOWN_EXTENSIONS = [".md", ".markdown"] as const;

export const isEmailMimeType = (mimeType: string | null | undefined): boolean =>
  mimeType === undefined || mimeType === null
    ? false
    : EMAIL_MIME_TYPES.has(mimeType);

export const emailMimeTypeFromFileName = (
  fileName: string | null | undefined,
): string | null => {
  const dotIndex = fileName?.lastIndexOf(".") ?? -1;
  if (!fileName || dotIndex === -1) {
    return null;
  }
  const extension = fileName.slice(dotIndex + 1).toLowerCase();
  return EMAIL_EXTENSION_MIME_TYPES[extension] ?? null;
};

export const isEmailFile = ({
  fileName,
  mimeType,
}: {
  fileName?: string | null | undefined;
  mimeType?: string | null | undefined;
}): boolean =>
  isEmailMimeType(mimeType) || emailMimeTypeFromFileName(fileName) !== null;

export const isMarkdownFile = ({
  fileName,
  mimeType,
}: {
  fileName?: string | null | undefined;
  mimeType?: string | null | undefined;
}): boolean => {
  const normalizedMimeType = mimeType?.toLowerCase();
  if (
    normalizedMimeType === MARKDOWN_MIME ||
    normalizedMimeType?.startsWith(`${MARKDOWN_MIME};`)
  ) {
    return true;
  }

  const lowered = fileName?.toLowerCase();
  return lowered
    ? MARKDOWN_EXTENSIONS.some((extension) => lowered.endsWith(extension))
    : false;
};

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
/** Outer container classes for the inspector icon rail. The lazy-load
 * fallback rail must stay pixel-identical to the real rail, so both
 * read this single source instead of repeating the string. */
export const SIDE_RAIL_CONTAINER_CLASS =
  `bg-sidebar flex shrink-0 flex-col border-e ${SIDE_RAIL_WIDTH}` as const;
export const SIDE_RAIL_ICON_BUTTON_SIZE = "size-8" as const;
/** Glyph size inside a rail tab button — matches the `size-3.5`
 * class every built-in rail icon uses. Numeric form is for
 * components that take a pixel size prop instead of a Tailwind
 * class (e.g. bundled image icons). Keep both in sync; they refer
 * to the same 14px design token. */
export const SIDE_RAIL_TAB_ICON_SIZE = "size-3.5" as const;
export const SIDE_RAIL_TAB_ICON_SIZE_PX = 14 as const;

export const STALE_TIME = {
  INFINITE: Number.POSITIVE_INFINITY,
  FIVE: {
    MINUTES: 5 * 60 * 1000,
  },
  FIVETEEN: {
    MINUTES: 15 * 60 * 1000,
  },
};
