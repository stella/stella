import * as v from "valibot";

import { utf8ByteBounds } from "@/api/lib/custom-schema";

export const DATA_EXPORT_ARCHIVE_PATH_MAX_BYTES = 4096;
export const DATA_EXPORT_ARCHIVE_SEGMENT_MAX_BYTES = 255;

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
  utf8ByteBounds({
    maxBytes: DATA_EXPORT_ARCHIVE_PATH_MAX_BYTES,
    maxSegmentBytes: DATA_EXPORT_ARCHIVE_SEGMENT_MAX_BYTES,
  }),
  v.description(
    "Path inside the part's ZIP archive, `/`-separated, NFC-normalised; at most 4096 UTF-8 bytes total and 255 UTF-8 bytes per segment.",
  ),
);
