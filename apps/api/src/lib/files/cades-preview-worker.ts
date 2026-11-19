import { Result } from "better-result";

import { detectEmbeddedPayload } from "@/api/lib/files/embedded-payload-format";
import { parseP7m } from "@/api/lib/files/p7m";
import { sanitizeFilenamePreservingExtension } from "@/api/lib/sanitize-filename";

const derivePayloadName = (outerName: string, extension: string | null) => {
  const stem = outerName.replace(/(?:\.p7m)+$/iu, "").trim() || "attachment";
  const name =
    extension && !stem.toLowerCase().endsWith(`.${extension}`)
      ? `${stem}.${extension}`
      : stem;
  return sanitizeFilenamePreservingExtension(name);
};

/** The CMS parser is isolated in the worker. Its payload needs its own scan. */
export const scanCadesPayload = async (
  fileBytes: Uint8Array,
  outerName: string,
) => {
  const parsed = parseP7m(fileBytes);
  if (parsed.isErr()) {
    return Result.err(parsed.error);
  }
  const { bytes, layers } = parsed.value;
  const { mimeType, extension } = detectEmbeddedPayload(bytes);
  const fileName = derivePayloadName(outerName, extension);
  const { scanUpload } = await import("@/api/lib/file-scan/scan-upload");
  const scanned = await scanUpload({
    bytes,
    ownership: "transfer",
    declaredMimeType: mimeType,
    fileName,
  });
  if (scanned.isErr()) {
    return Result.err(scanned.error);
  }
  return Result.ok({
    file: scanned.value,
    layers: layers.map(({ signers }) => ({
      signers: signers.map(({ name }) => ({ name })),
    })),
  });
};
