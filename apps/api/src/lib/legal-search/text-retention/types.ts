import { TaggedError } from "better-result";

export const TEXT_FORMAT = {
  HTML: "html",
  XML: "xml",
  DOCX: "docx",
  PDF: "pdf",
  RTF: "rtf",
  JSON: "json",
  TEXT: "text",
} as const;

export type TextFormat = (typeof TEXT_FORMAT)[keyof typeof TEXT_FORMAT];

export const ORACLE_VERSION = 1;

export class TextOracleError extends TaggedError("TextOracleError")<{
  message: string;
  reason: "malformed" | "resource_limit" | "unsupported" | "no_text_layer";
  cause?: unknown;
}> {}

/** Limits apply before decoding and while walking; exhaustion never means clean. */
export const TEXT_ORACLE_LIMITS = {
  rawBytes: 32 * 1024 * 1024,
  textCharacters: 8 * 1024 * 1024,
  nodes: 500_000,
  depth: 256,
  pdfPages: 2000,
} as const;

export type TextBaseline = {
  text: string;
};
