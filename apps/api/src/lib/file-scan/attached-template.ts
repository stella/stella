import { panic, Result } from "better-result";

import { ZipArchive, type ZipEntry } from "@stll/docx-core/zip";
import {
  ATTACHED_TEMPLATE_SECURITY_RULE,
  isOpcRelationshipPartPath,
  sanitizeAttachedTemplateRelationships,
} from "@stll/docx-utils";
import { OFFICE_ARCHIVE_FORMATS } from "@stll/docx-utils/office-formats";

import {
  scanMediaType,
  scanMediaTypeSet,
} from "@/api/lib/file-scan/media-type";
import type { Match, ScanContext, Scanner } from "@/api/lib/file-scan/scanner";
import { hasZipMagic } from "@/api/lib/file-scan/zip";

const MAX_ARCHIVE_ENTRIES = 1000;
const MAX_RELATIONSHIPS_ENTRY_BYTES = 1024 * 1024;
const MAX_RELATIONSHIPS_TOTAL_BYTES = 8 * 1024 * 1024;
const WORD_OPENXML_FORMATS = Object.entries(OFFICE_ARCHIVE_FORMATS).filter(
  ([, format]) => format.family === "word",
);
const WORD_OPENXML_MIME_TYPES = scanMediaTypeSet(
  WORD_OPENXML_FORMATS.map(([, format]) => format.mimeType),
);
const WORD_OPENXML_EXTENSIONS = WORD_OPENXML_FORMATS.map(
  ([extension]) => `.${extension}`,
);

const ATTACHED_TEMPLATE_FINDING: Match = {
  rule: ATTACHED_TEMPLATE_SECURITY_RULE,
  severity: "malicious",
  meta: {
    description:
      "Document contains an external Word template link " +
      "(potential template injection)",
  },
};

const RELATIONSHIPS_INSPECTION_FAILED: Match = {
  rule: "ooxml_relationships_unreadable",
  severity: "malicious",
  meta: {
    description:
      "Document relationships could not be safely inspected for external content",
  },
};

type RelationshipEntryRead =
  { type: "ok"; xml: string } | { type: "too-large" } | { type: "unreadable" };

const isWordOpenXmlUpload = (context: ScanContext | undefined): boolean => {
  if (context === undefined) {
    return false;
  }
  if (WORD_OPENXML_MIME_TYPES.has(scanMediaType(context.mimeType))) {
    return true;
  }
  const fileName = context.filename.toLowerCase();
  return WORD_OPENXML_EXTENSIONS.some((extension) =>
    fileName.endsWith(extension),
  );
};

/**
 * Read one relationship part, refusing it from its declared size. Inflation
 * stops at that size, so the cap bounds memory, not just the result.
 */
const readRelationshipEntry = async (
  entry: ZipEntry,
  maxBytes: number,
): Promise<RelationshipEntryRead> => {
  if (entry.size > maxBytes) {
    return { type: "too-large" };
  }
  const read = await Result.tryPromise({
    try: async () => await entry.text(),
    catch: (cause) => cause,
  });
  return Result.isOk(read)
    ? { type: "ok", xml: read.value }
    : { type: "unreadable" };
};

/**
 * Structural attached-template detection. It inspects each relationship part
 * independently, so a harmless `http://` namespace in one part cannot combine
 * with `attachedTemplate` text in another and become a false positive.
 */
export const attachedTemplateScanner: Scanner = {
  async scan(bytes, context) {
    if (!isWordOpenXmlUpload(context) || !hasZipMagic(bytes)) {
      return [];
    }

    const loaded = await Result.tryPromise({
      try: async () => await ZipArchive.read(bytes),
      catch: (cause) => cause,
    });
    if (Result.isError(loaded)) {
      return [];
    }
    const zip = loaded.value;

    const entries = zip.entries();
    if (entries.length > MAX_ARCHIVE_ENTRIES) {
      // The zip-bomb guard owns this rejection and reports its exact limit.
      return [];
    }

    let remainingBytes = MAX_RELATIONSHIPS_TOTAL_BYTES;
    for (const entry of entries) {
      if (!isOpcRelationshipPartPath(entry.path)) {
        continue;
      }
      if (remainingBytes <= 0) {
        return [RELATIONSHIPS_INSPECTION_FAILED];
      }

      const read = await readRelationshipEntry(
        entry,
        Math.min(MAX_RELATIONSHIPS_ENTRY_BYTES, remainingBytes),
      );
      switch (read.type) {
        case "too-large":
        case "unreadable":
          return [RELATIONSHIPS_INSPECTION_FAILED];
        case "ok": {
          remainingBytes -= Buffer.byteLength(read.xml);
          const sanitized = Result.try({
            try: () =>
              sanitizeAttachedTemplateRelationships(read.xml, entry.path),
            catch: (cause) => cause,
          });
          if (Result.isError(sanitized)) {
            return [RELATIONSHIPS_INSPECTION_FAILED];
          }
          if (sanitized.value.findings.length > 0) {
            return [ATTACHED_TEMPLATE_FINDING];
          }
          break;
        }
        default:
          read satisfies never;
          return panic(`Unhandled relationship entry read: ${String(read)}`);
      }
    }

    return [];
  },
};
