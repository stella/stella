import { PDF } from "@libpdf/core";
import { panic, Result } from "better-result";

import { readDocxText } from "./docx";
import { readRtfText } from "./rtf";
import {
  TEXT_FORMAT,
  TEXT_ORACLE_LIMITS,
  TextOracleError,
  type TextBaseline,
} from "./types";

const readPdfText = async (
  raw: Uint8Array,
): Promise<Result<TextBaseline, TextOracleError>> => {
  const loaded = await Result.tryPromise({
    try: () => PDF.load(raw, { lenient: false }),
    catch: (cause) =>
      new TextOracleError({
        message: "Cannot read PDF text layer",
        reason: "malformed",
        cause,
      }),
  });
  if (loaded.isErr()) {
    return loaded;
  }
  const pdf = loaded.value;
  if (pdf.isEncrypted && !pdf.isAuthenticated) {
    return Result.err(
      new TextOracleError({
        message: "PDF requires credentials",
        reason: "unsupported",
      }),
    );
  }
  if (pdf.getPageCount() > TEXT_ORACLE_LIMITS.pdfPages) {
    return Result.err(
      new TextOracleError({
        message: "PDF page limit exceeded",
        reason: "resource_limit",
      }),
    );
  }
  const output: string[] = [];
  let textCharacters = 0;
  let nodes = 0;
  for (const page of pdf.getPages()) {
    const extracted = Result.try({
      try: () => page.extractText(),
      catch: (cause) =>
        new TextOracleError({
          message: "Cannot extract PDF page text",
          reason: "malformed",
          cause,
        }),
    });
    if (extracted.isErr()) {
      return extracted;
    }
    const { text, lines } = extracted.value;
    textCharacters += text.length + 1;
    nodes += lines.length;
    for (const line of lines) {
      nodes += line.spans.length;
      for (const span of line.spans) {
        nodes += span.chars.length;
      }
    }
    if (
      textCharacters > TEXT_ORACLE_LIMITS.textCharacters ||
      nodes > TEXT_ORACLE_LIMITS.nodes
    ) {
      return Result.err(
        new TextOracleError({
          message: "PDF text layer limit exceeded",
          reason: "resource_limit",
        }),
      );
    }
    // Page text precedes every court-specific span, margin and line filter.
    output.push(text, "\n");
  }
  const text = output.join("");
  if (text.trim() === "") {
    return Result.err(
      new TextOracleError({
        message: "PDF has no readable text layer",
        reason: "no_text_layer",
      }),
    );
  }
  return Result.ok({ text });
};

type ReadBinaryTextOptions = {
  raw: Uint8Array;
  format: "docx" | "pdf" | "rtf";
};
export const readBinaryText = async ({
  raw,
  format,
}: ReadBinaryTextOptions): Promise<Result<TextBaseline, TextOracleError>> => {
  if (raw.byteLength > TEXT_ORACLE_LIMITS.rawBytes) {
    return Result.err(
      new TextOracleError({
        message: "Binary text input exceeds size limit",
        reason: "resource_limit",
      }),
    );
  }
  switch (format) {
    case TEXT_FORMAT.DOCX:
      return await readDocxText(raw);
    case TEXT_FORMAT.PDF:
      return await readPdfText(raw);
    case TEXT_FORMAT.RTF:
      return readRtfText(raw);
    default:
      return panic("Unexpected binary oracle format", format satisfies never);
  }
};
