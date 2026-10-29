/** Opaque sRGB colours shared by the visible signature stamp. */
import { BRAND_SRGB } from "@stll/brand";

import { PDF_NEUTRALS } from "@/api/lib/files/pdf-color";

/** The brand accent for the mark and dividing rule. */
export const STAMP_BRAND_BLUE = BRAND_SRGB.blueAccent;

/** The signer name, in both columns. */
export const STAMP_NAME_COLOR = PDF_NEUTRALS.stampName;

/** The rest of the signing details. */
export const STAMP_DETAIL_COLOR = PDF_NEUTRALS.stampDetail;
