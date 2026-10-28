import { panic } from "better-result";
import { deflateRawSync, inflateRawSync } from "node:zlib";

export type PostgresTestSelection =
  { mode: "all" | "none" } | { mode: "selected"; files: readonly string[] };

const encodeJson = (value: unknown) =>
  deflateRawSync(JSON.stringify(value), { level: 9 }).toString("base64");

const decodeJson = (value: string): unknown => {
  if (value === "") {
    panic("Encoded plan output must not be empty");
  }
  return JSON.parse(
    inflateRawSync(Buffer.from(value, "base64")).toString("utf-8"),
  );
};

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

export const encodePlanFileList = (files: readonly string[]): string =>
  encodeJson(files);

export const decodePlanFileList = (value: string): string[] => {
  const decoded = decodeJson(value);
  if (!isStringArray(decoded)) {
    panic("Encoded plan file list must contain a string array");
  }
  return decoded;
};

export const encodePostgresTestSelection = (
  selection: PostgresTestSelection,
): string => encodeJson(selection);

export const decodePostgresTestSelection = (
  value: string,
): PostgresTestSelection => {
  const decoded = decodeJson(value);
  if (typeof decoded !== "object" || decoded === null || !("mode" in decoded)) {
    panic("Encoded Postgres selection must contain a selection object");
  }
  if (decoded.mode === "all" || decoded.mode === "none") {
    return { mode: decoded.mode };
  }
  if (
    decoded.mode === "selected" &&
    "files" in decoded &&
    isStringArray(decoded.files)
  ) {
    return { mode: "selected", files: decoded.files };
  }
  return panic("Encoded Postgres selection has an invalid mode or file list");
};

if (import.meta.main) {
  if (Bun.argv.at(2) !== "decode-postgres") {
    panic("Expected decode-postgres");
  }
  // An empty selection is no explicit selection: the full suite runs.
  const encoded = process.env["CI_POSTGRES_TEST_SELECTION_ENCODED"] ?? "";
  process.stdout.write(
    JSON.stringify(
      encoded === "" ? { mode: "all" } : decodePostgresTestSelection(encoded),
    ),
  );
}
