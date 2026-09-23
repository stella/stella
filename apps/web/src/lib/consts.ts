import { panic } from "better-result";

import {
  DESKTOP_EDIT_FILE_TYPE_CONFIG,
  desktopEditFileTypeForMimeType,
} from "@stll/api-contract";
import {
  EML_MIME_TYPE,
  MSG_MIME_TYPE,
  resolveEmailMimeType,
} from "@stll/api-contract/email-mime-types";

export const DOCX_MIME = DESKTOP_EDIT_FILE_TYPE_CONFIG.docx.mimeType;
export const XLSX_MIME = DESKTOP_EDIT_FILE_TYPE_CONFIG.xlsx.mimeType;
export const PPTX_MIME = DESKTOP_EDIT_FILE_TYPE_CONFIG.pptx.mimeType;

export type NativeOfficeViewerFormat = "pptx" | "xlsx";

export const getNativeOfficeViewerFormat = (
  mimeType: string | null | undefined,
): NativeOfficeViewerFormat | null => {
  const fileType = desktopEditFileTypeForMimeType(mimeType ?? "");
  switch (fileType) {
    case "xlsx":
      return "xlsx";
    case "pptx":
      return "pptx";
    case "docx":
    case null:
      return null;
    default:
      fileType satisfies never;
      return panic(`Unhandled file type: ${String(fileType)}`);
  }
};

export const isDocxFile = (file: Pick<File, "name" | "type">): boolean =>
  file.type === DOCX_MIME || file.name.toLowerCase().endsWith(".docx");

export const PDF_MIME = "application/pdf" as const;
export const EML_MIME = EML_MIME_TYPE;
export const MSG_MIME = MSG_MIME_TYPE;
export const MARKDOWN_MIME = "text/markdown" as const;

const MARKDOWN_EXTENSIONS = [".md", ".markdown"] as const;

export const isEmailFile = ({
  fileName,
  mimeType,
}: {
  fileName?: string | null | undefined;
  mimeType?: string | null | undefined;
}): boolean => resolveEmailMimeType({ fileName, mimeType }) !== null;

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
export {
  TOOLBAR_ROW_HEIGHT,
  TOOLBAR_ROW_HEIGHT_PX,
} from "@stll/ui/layout-tokens";
export const TOOLBAR_ROW_MIN_HEIGHT = "min-h-12" as const;
/** Glyph size inside a rail tab button — matches the `size-3.5`
 * class every built-in rail icon uses. Numeric form is for
 * components that take a pixel size prop instead of a Tailwind
 * class (e.g. bundled image icons). Keep both in sync; they refer
 * to the same 14px design token. */
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

/** Invite to the project's community chat server: a public forum where
 *  maintainers and users help each other. Single source for every surface
 *  that links it (the feedback menu, the help drawer's Community tab). */
export const COMMUNITY_FORUM_URL = "https://discord.gg/8dZjmVFjTK" as const;

export const GITHUB_FEEDBACK_URL =
  "https://github.com/stella/stella/issues/new/choose" as const;

export const TECHNICAL_DOCS_URL = "https://stll.app/docs/" as const;

/** General contact address. Used where someone wants to reach the team directly
 *  rather than ask the community: it opens a conversation, so surfaces linking
 *  it must not imply a committed response time. */
export const CONTACT_EMAIL = "hello@stll.app" as const;
