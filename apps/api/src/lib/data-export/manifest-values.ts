import * as v from "valibot";

export const dataExportIdSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(255),
);
export const dataExportSha256Schema = v.pipe(
  v.string(),
  v.regex(/^[0-9a-f]{64}$/u),
  v.description("Lowercase hex SHA-256 of the file bytes."),
);
export const dataExportArchivePathSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(4096),
  v.description(
    "Path inside the part's ZIP archive, `/`-separated, NFC-normalised.",
  ),
);
