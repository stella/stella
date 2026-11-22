/**
 * The media type a part of a stored file (an attachment, a container's
 * member, a signed envelope's document) is listed and delivered as. Every
 * preview that lists parts and every reader that delivers one takes the type
 * from here, so a part opens as the type its list showed.
 */
import { declaredMimeMatchesMagic } from "@/api/lib/file-scan/magic";
import { hasZipMagic, readZipIndex } from "@/api/lib/file-scan/zip";
import {
  detectEmbeddedPayload,
  OPAQUE_EMBEDDED_MIME_TYPE,
} from "@/api/lib/files/embedded-payload-format";
import { resolveUploadMime } from "@/api/lib/files/upload-mime";
import {
  DOCX_MIME_TYPE,
  ODP_MIME_TYPE,
  ODS_MIME_TYPE,
  ODT_MIME_TYPE,
  PPTX_MIME_TYPE,
  XLSX_MIME_TYPE,
} from "@/api/mime-types";

const OFFICE_PARTS = {
  "word/document.xml": DOCX_MIME_TYPE,
  "xl/workbook.xml": XLSX_MIME_TYPE,
  "ppt/presentation.xml": PPTX_MIME_TYPE,
};

const ODF_MIME_MARKERS = [ODT_MIME_TYPE, ODS_MIME_TYPE, ODP_MIME_TYPE];

const readOfficeMimeType = (bytes: Uint8Array): string | null => {
  const index = readZipIndex(bytes);
  if (index.type === "malformed") {
    return null;
  }
  const names = new Set(
    index.entries.map(({ name }) => name.toString("utf-8")),
  );
  if (names.has("[Content_Types].xml")) {
    const candidates = Object.entries(OFFICE_PARTS).filter(([part]) =>
      names.has(part),
    );
    return candidates.length === 1 ? (candidates.at(0)?.[1] ?? null) : null;
  }

  if (names.has("content.xml")) {
    const mimeEntry = index.entries.at(0);
    if (
      mimeEntry?.name.toString("utf-8") === "mimetype" &&
      mimeEntry.method === 0
    ) {
      return (
        ODF_MIME_MARKERS.find(
          (mimeType) =>
            mimeEntry.data.byteLength === mimeType.length &&
            Buffer.from(mimeEntry.data).equals(Buffer.from(mimeType)),
        ) ?? null
      );
    }
  }
  return null;
};

/** The media type a member is scanned and read as, from its own bytes. */
export const containerMemberMimeType = async (bytes: Uint8Array) => {
  const { zipBombGuard } = await import("@/api/lib/file-scan/pipeline");
  // ZIP packages are recognized from their directory without inflating a
  // nested archive. The exact bytes still go through the usual upload scan.
  const officeMimeType =
    hasZipMagic(bytes) && (await zipBombGuard.scan(bytes)).length === 0
      ? readOfficeMimeType(bytes)
      : null;
  return officeMimeType ?? detectEmbeddedPayload(bytes).mimeType;
};

const TEXTUAL_MEDIA_TYPE =
  /^(?:text\/|application\/(?:[\w.+-]+\+)?(?:xml|json)$)/u;

const essence = (mediaType: string) =>
  (mediaType.split(";", 1).at(0) ?? "").trim().toLowerCase();

type PartMediaTypeClaim = {
  /** What the container states the part is, if anything. */
  stated: string | null;
  /** The part's name, whose extension stands in for a generic statement. */
  fileName: string | null;
};

/**
 * The type a part is, given what its bytes show (`detected`, from
 * `containerMemberMimeType`). The bytes decide wherever they show a type;
 * otherwise the container's claim stands unless the bytes contradict it (a
 * signature the bytes lack, or text that is not text), and an unsupported
 * claim leaves the part opaque.
 */
export const partMediaTypeOf = ({
  bytes,
  detected,
  stated,
  fileName,
}: PartMediaTypeClaim & { bytes: Uint8Array; detected: string }): string => {
  if (detected !== OPAQUE_EMBEDDED_MIME_TYPE) {
    return detected;
  }
  const claimed = essence(
    resolveUploadMime({
      declaredMime: essence(stated ?? "") || OPAQUE_EMBEDDED_MIME_TYPE,
      fileName: fileName ?? "",
    }),
  );
  if (
    claimed === "" ||
    // Text the detector would have recognized; these bytes are not text.
    TEXTUAL_MEDIA_TYPE.test(claimed) ||
    !declaredMimeMatchesMagic(claimed, bytes)
  ) {
    return OPAQUE_EMBEDDED_MIME_TYPE;
  }
  return claimed;
};

/** The type a part is listed and delivered as; see `partMediaTypeOf`. */
export const partMediaType = async (
  claim: PartMediaTypeClaim & { bytes: Uint8Array },
): Promise<string> =>
  partMediaTypeOf({
    ...claim,
    detected: await containerMemberMimeType(claim.bytes),
  });
