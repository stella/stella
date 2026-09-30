import { Result } from "better-result";

import { isRecord } from "@/api/lib/type-guards";

import { readMarkupText } from "./markup";
import { TEXT_ORACLE_LIMITS, TextOracleError } from "./types";

/** Paths describe source text fields, never layout tags or inferred metadata strings. */
type JsonTextField = {
  path: readonly string[];
  format: "text" | "html" | "xml";
};

type ReadJsonTextOptions = {
  raw: Uint8Array;
  fields: readonly JsonTextField[];
};

export const readJsonText = ({ raw, fields }: ReadJsonTextOptions) => {
  if (raw.byteLength > TEXT_ORACLE_LIMITS.rawBytes) {
    return Result.err(
      new TextOracleError({
        reason: "resource_limit",
        message: "JSON source exceeds the byte limit",
      }),
    );
  }
  const parsed = Result.try({
    try: (): unknown =>
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)),
    catch: (cause) =>
      new TextOracleError({
        reason: "malformed",
        message: "Source JSON cannot be decoded",
        cause,
      }),
  });
  if (parsed.isErr()) {
    return parsed;
  }
  const parts: string[] = [];
  let nodes = 0;
  let characters = 0;
  for (const field of fields) {
    if (
      field.path.length === 0 ||
      field.path.length > TEXT_ORACLE_LIMITS.depth
    ) {
      return Result.err(
        new TextOracleError({
          reason: "malformed",
          message: "JSON text field needs a bounded path",
        }),
      );
    }
    let values: unknown[] = [parsed.value];
    for (const segment of field.path) {
      const children: unknown[] = [];
      for (const value of values) {
        nodes += 1;
        if (nodes > TEXT_ORACLE_LIMITS.nodes) {
          return Result.err(
            new TextOracleError({
              reason: "resource_limit",
              message: "JSON source exceeds the traversal limit",
            }),
          );
        }
        if (segment === "*") {
          if (!Array.isArray(value)) {
            return Result.err(
              new TextOracleError({
                reason: "malformed",
                message: "JSON text path expected an array",
              }),
            );
          }
          if (value.length + nodes > TEXT_ORACLE_LIMITS.nodes) {
            return Result.err(
              new TextOracleError({
                reason: "resource_limit",
                message: "JSON source exceeds the array limit",
              }),
            );
          }
          for (const child of value) {
            children.push(child);
          }
          continue;
        }
        if (!isRecord(value) || !Object.hasOwn(value, segment)) {
          return Result.err(
            new TextOracleError({
              reason: "malformed",
              message: "JSON source is missing a declared text field",
            }),
          );
        }
        children.push(value[segment]);
      }
      values = children;
    }
    for (const value of values) {
      if (typeof value !== "string") {
        return Result.err(
          new TextOracleError({
            reason: "malformed",
            message: "JSON text field is not a string",
          }),
        );
      }
      const text =
        field.format === "text"
          ? Result.ok({ text: value })
          : readMarkupText({
              raw: new TextEncoder().encode(value),
              format: field.format,
            });
      if (text.isErr()) {
        return text;
      }
      characters += text.value.text.length + 1;
      if (characters > TEXT_ORACLE_LIMITS.textCharacters) {
        return Result.err(
          new TextOracleError({
            reason: "resource_limit",
            message: "JSON text exceeds the character limit",
          }),
        );
      }
      parts.push(text.value.text);
    }
  }
  if (fields.length === 0) {
    return Result.err(
      new TextOracleError({
        reason: "malformed",
        message: "JSON oracle needs declared source text fields",
      }),
    );
  }
  return Result.ok({ text: parts.join("\n") });
};
