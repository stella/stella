import * as v from "valibot";

import type { OfficeCitationLocator } from "@stll/api-contract";

import {
  OFFICE_EVIDENCE_FORMAT,
  OFFICE_EVIDENCE_LIMITS,
  OFFICE_EVIDENCE_STATUS,
  OFFICE_EVIDENCE_UNAVAILABLE_CODE,
  OFFICE_EVIDENCE_UNAVAILABLE_CODES,
  type OfficeEvidenceFormat,
  type OfficeEvidenceUnavailableCode,
} from "@/api/lib/files/office-evidence-domain";

export {
  OFFICE_EVIDENCE_FORMAT,
  OFFICE_EVIDENCE_STATUS,
  OFFICE_EVIDENCE_UNAVAILABLE_CODE,
  type OfficeEvidenceFormat,
  type OfficeEvidenceUnavailableCode,
};

export const OFFICE_EVIDENCE_PARSER_VERSION = 1;

export type OfficeEvidenceBlock =
  | PptxOfficeEvidenceBlock
  | XlsxOfficeEvidenceBlock;

export type PptxOfficeEvidenceBlock = {
  id: string;
  locator: Extract<OfficeCitationLocator, { type: "pptx" }>;
  text: string;
};

export type XlsxOfficeEvidenceBlock = {
  id: string;
  locator: Extract<OfficeCitationLocator, { type: "xlsx" }>;
  text: string;
};

export type OfficeEvidencePayload =
  | {
      blocks: PptxOfficeEvidenceBlock[];
      format: typeof OFFICE_EVIDENCE_FORMAT.pptx;
      version: 1;
    }
  | {
      blocks: XlsxOfficeEvidenceBlock[];
      format: typeof OFFICE_EVIDENCE_FORMAT.xlsx;
      version: 1;
    };

export type OfficeEvidenceWorkerResult =
  | {
      payload: OfficeEvidencePayload;
      status: typeof OFFICE_EVIDENCE_STATUS.available;
    }
  | {
      errorCode: OfficeEvidenceUnavailableCode;
      status: typeof OFFICE_EVIDENCE_STATUS.unavailable;
    };

const pptxBlockIdSchema = v.pipe(v.string(), v.regex(/^pptx-[0-9a-f]{16}$/u));
const xlsxBlockIdSchema = v.pipe(v.string(), v.regex(/^xlsx-[0-9a-f]{16}$/u));

const xlsxLocatorSchema = v.object({
  type: v.literal("xlsx"),
  range: v.pipe(v.string(), v.maxLength(64)),
  sheetIndex: v.pipe(v.number(), v.integer(), v.minValue(0)),
  sheetName: v.pipe(v.string(), v.maxLength(31)),
});

const pptxLocatorSchema = v.object({
  type: v.literal("pptx"),
  slideIndex: v.pipe(v.number(), v.integer(), v.minValue(0)),
});

const blockTextSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(OFFICE_EVIDENCE_LIMITS.blockTextMaxChars),
);

const pptxBlockSchema = v.object({
  id: pptxBlockIdSchema,
  locator: pptxLocatorSchema,
  text: blockTextSchema,
});

const xlsxBlockSchema = v.object({
  id: xlsxBlockIdSchema,
  locator: xlsxLocatorSchema,
  text: blockTextSchema,
});

export const officeEvidencePayloadSchema = v.variant("format", [
  v.object({
    blocks: v.pipe(
      v.array(pptxBlockSchema),
      v.maxLength(OFFICE_EVIDENCE_LIMITS.blocksMax),
    ),
    format: v.literal(OFFICE_EVIDENCE_FORMAT.pptx),
    version: v.literal(1),
  }),
  v.object({
    blocks: v.pipe(
      v.array(xlsxBlockSchema),
      v.maxLength(OFFICE_EVIDENCE_LIMITS.blocksMax),
    ),
    format: v.literal(OFFICE_EVIDENCE_FORMAT.xlsx),
    version: v.literal(1),
  }),
]);

const unavailableResultSchema = v.object({
  errorCode: v.picklist(OFFICE_EVIDENCE_UNAVAILABLE_CODES),
  status: v.literal(OFFICE_EVIDENCE_STATUS.unavailable),
});

const availableResultSchema = v.object({
  payload: officeEvidencePayloadSchema,
  status: v.literal(OFFICE_EVIDENCE_STATUS.available),
});

export const officeEvidenceWorkerResultSchema = v.variant("status", [
  availableResultSchema,
  unavailableResultSchema,
]);
