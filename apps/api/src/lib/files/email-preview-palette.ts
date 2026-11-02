// The email preview's own colours: the paper, the header block above the
// message, the divider, the fold control and the citation highlight. The
// preview is a standalone light document that no app stylesheet reaches, so its
// palette is named once here; the paper is @stll/brand's neutral white.

import { NEUTRAL_COLORS } from "@stll/brand";

export const EMAIL_PREVIEW_PALETTE = {
  paper: NEUTRAL_COLORS.white,
  ink: "#18181b",
  divider: "#d4d4d8",
  headerSurface: "#fafafa",
  headerBorder: "#e4e4e7",
  label: "#71717a",
  foldHoverSurface: "#f4f4f5",
  foldHoverInk: "#3f3f46",
  citationSurface: "#fef3c7",
  citationOutline: "#f59e0b",
} as const;
