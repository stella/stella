import { panic, Result } from "better-result";

import { readBinaryText } from "./binary";
import { readJsonText } from "./json";
import { readMarkupText } from "./markup";
import { TEXT_FORMAT, TEXT_ORACLE_LIMITS, TextOracleError } from "./types";

type BaselineInput =
  | Parameters<typeof readMarkupText>[0]
  | Parameters<typeof readBinaryText>[0]
  | ({ format: "json" } & Parameters<typeof readJsonText>[0])
  | { format: "text"; raw: Uint8Array };

/** Captured transport bytes are decoded before court layout parsing or filtering. */
export const readTextBaseline = async (input: BaselineInput) => {
  switch (input.format) {
    case TEXT_FORMAT.HTML:
    case TEXT_FORMAT.XML:
      return readMarkupText(input);
    case TEXT_FORMAT.DOCX:
    case TEXT_FORMAT.PDF:
    case TEXT_FORMAT.RTF:
      return await readBinaryText(input);
    case TEXT_FORMAT.JSON:
      return readJsonText(input);
    case TEXT_FORMAT.TEXT: {
      if (input.raw.byteLength > TEXT_ORACLE_LIMITS.rawBytes) {
        return Result.err(
          new TextOracleError({
            reason: "resource_limit",
            message: "Text source exceeds the byte limit",
          }),
        );
      }
      return Result.try({
        try: () => new TextDecoder("utf-8", { fatal: true }).decode(input.raw),
        catch: (cause) =>
          new TextOracleError({
            reason: "malformed",
            message: "Text source is not valid UTF-8",
            cause,
          }),
      }).andThen((text) =>
        text.length > TEXT_ORACLE_LIMITS.textCharacters
          ? Result.err(
              new TextOracleError({
                reason: "resource_limit",
                message: "Text source exceeds the character limit",
              }),
            )
          : Result.ok({ text }),
      );
    }
    default:
      input satisfies never;
      return panic("Unhandled source text format");
  }
};
