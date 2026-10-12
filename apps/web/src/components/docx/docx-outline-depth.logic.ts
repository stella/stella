import * as v from "valibot";

export const DOCX_OUTLINE_DEPTH_STORAGE_KEY = "docx_outline_depth";

export const DOCX_OUTLINE_DEPTH = {
  two: 2,
  three: 3,
  all: "all",
} as const;

export type DocxOutlineDepth =
  (typeof DOCX_OUTLINE_DEPTH)[keyof typeof DOCX_OUTLINE_DEPTH];

const STORED_DEPTH_TWO = `${DOCX_OUTLINE_DEPTH.two}`;
const STORED_DEPTH_THREE = `${DOCX_OUTLINE_DEPTH.three}`;
const StoredDocxOutlineDepthSchema = v.picklist([
  STORED_DEPTH_TWO,
  STORED_DEPTH_THREE,
  DOCX_OUTLINE_DEPTH.all,
]);

export const parseDocxOutlineDepth = (raw: string | null): DocxOutlineDepth => {
  const result = v.safeParse(StoredDocxOutlineDepthSchema, raw);
  if (!result.success) {
    return DOCX_OUTLINE_DEPTH.two;
  }
  if (result.output === STORED_DEPTH_TWO) {
    return DOCX_OUTLINE_DEPTH.two;
  }
  if (result.output === STORED_DEPTH_THREE) {
    return DOCX_OUTLINE_DEPTH.three;
  }
  return DOCX_OUTLINE_DEPTH.all;
};
