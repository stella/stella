// `--file <path>` on a generated leaf: local bytes for a tool whose document
// arrives as base64.
//
// The tool contract is unchanged by this flag. `create_template` takes the
// document either as a host `file` reference (an MCP host attaches it) or as
// `docx_base64`; a CLI caller is neither, so the flag reads the path and fills
// the SAME `docx_base64` input an MCP host could fill. The ceiling is the
// prop's own `maxLength` from the registry schema, read at call time, so the
// CLI cannot advertise a limit the server does not enforce.

import { Result } from "better-result";
import { readFile } from "node:fs/promises";

import type { JsonSchema } from "./route-types.js";

/** The public flag name; matches `stella upload --file <path>`. */
export const LOCAL_FILE_FLAG = "--file";

/** Parser key for `LOCAL_FILE_FLAG` (see `flag-name.ts`). */
export const LOCAL_FILE_FLAG_KEY = "file";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export type LocalFileLimits = {
  /** Base64 characters the prop accepts, from the schema's `maxLength`. */
  maxBase64Length: number;
  /** The file size that encodes to at most that many characters. */
  maxBytes: number;
};

/**
 * The prop's declared ceiling, or `undefined` when the schema does not state
 * one. Codegen refuses an annotated prop without a `maxLength`
 * (`generate-route-map.ts`), so `undefined` here means the leaf was rebuilt
 * from a live registry whose schema dropped it: the server still enforces its
 * own limit, and the CLI sends rather than inventing a number.
 */
export const localFileLimits = ({
  inputSchema,
  prop,
}: {
  inputSchema: JsonSchema;
  prop: string;
}): LocalFileLimits | undefined => {
  const properties = inputSchema["properties"];
  if (!isRecord(properties)) {
    return undefined;
  }
  const propSchema = properties[prop];
  if (!isRecord(propSchema)) {
    return undefined;
  }
  const maxLength = propSchema["maxLength"];
  if (typeof maxLength !== "number" || !Number.isFinite(maxLength)) {
    return undefined;
  }
  return {
    maxBase64Length: maxLength,
    // 4 base64 characters per 3 bytes, rounded down to a whole 3-byte group.
    maxBytes: Math.floor(maxLength / 4) * 3,
  };
};

/** `196608 bytes (192 KB)` — the cap stated both ways, for the help line. */
export const describeLimit = (limits: LocalFileLimits): string =>
  `${limits.maxBytes} bytes (${Math.floor(limits.maxBytes / 1024)} KB)`;

/**
 * Read `path` and encode it for `prop`, or say why it cannot travel this way.
 *
 * The over-cap message names the enforced ceiling and points at the host-file
 * route. It never suggests re-exporting or trimming the document: a template
 * that lost a part is a worse outcome than a refused call.
 */
export const readLocalFileAsBase64 = async ({
  commandLabel,
  limits,
  path,
  prop,
}: {
  commandLabel: string;
  limits: LocalFileLimits | undefined;
  path: string;
  prop: string;
}): Promise<Result<string, string>> => {
  const read = await Result.tryPromise({
    try: async () => await readFile(path),
    catch: (cause) => cause,
  });
  if (Result.isError(read)) {
    return Result.err(`${LOCAL_FILE_FLAG} could not read ${path}`);
  }
  if (read.value.byteLength === 0) {
    return Result.err(`${LOCAL_FILE_FLAG} ${path} is empty`);
  }
  const encoded = read.value.toString("base64");
  if (limits !== undefined && encoded.length > limits.maxBase64Length) {
    return Result.err(
      `${LOCAL_FILE_FLAG} ${path} is ${read.value.byteLength} bytes; ` +
        `${commandLabel} sends it inline as ${prop}, which the tool caps at ` +
        `${limits.maxBase64Length} base64 characters (${describeLimit(limits)}). ` +
        "Send this document from an MCP host that attaches it to the tool's " +
        "'file' reference. Do not re-export or strip the document to fit.",
    );
  }
  return Result.ok(encoded);
};
