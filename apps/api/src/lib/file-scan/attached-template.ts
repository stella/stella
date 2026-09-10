import { Result, panic } from "better-result";
import JSZip from "jszip";

import {
  ATTACHED_TEMPLATE_SECURITY_RULE,
  sanitizeAttachedTemplateRelationships,
} from "@stll/docx-utils";

import type { Match, Scanner } from "@/api/lib/file-scan/scanner";
import { hasZipMagic } from "@/api/lib/file-scan/zip";

const MAX_ARCHIVE_ENTRIES = 1000;
const MAX_RELATIONSHIPS_ENTRY_BYTES = 1024 * 1024;
const MAX_RELATIONSHIPS_TOTAL_BYTES = 8 * 1024 * 1024;

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
  | { type: "ok"; xml: string }
  | { type: "too-large" }
  | { type: "unreadable" };

const readRelationshipEntry = async (
  entry: JSZip.JSZipObject,
  maxBytes: number,
): Promise<RelationshipEntryRead> =>
  await new Promise<RelationshipEntryRead>((resolve) => {
    const stream = entry.nodeStream("nodebuffer");
    const chunks: Buffer[] = [];
    let bytesRead = 0;
    let settled = false;

    const finish = (result: RelationshipEntryRead) => {
      if (settled) {
        return;
      }
      settled = true;
      const destroy: unknown = Reflect.get(stream, "destroy");
      if (typeof destroy === "function") {
        Reflect.apply(destroy, stream, []);
      }
      resolve(result);
    };

    stream.on("data", (chunk: Buffer | string) => {
      if (settled) {
        return;
      }
      const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytesRead += piece.byteLength;
      if (bytesRead > maxBytes) {
        finish({ type: "too-large" });
        return;
      }
      chunks.push(piece);
    });
    stream.on("end", () => {
      if (!settled) {
        settled = true;
        resolve({ type: "ok", xml: Buffer.concat(chunks).toString("utf-8") });
      }
    });
    stream.on("error", () => finish({ type: "unreadable" }));
  });

/**
 * Structural attached-template detection. It inspects each relationship part
 * independently, so a harmless `http://` namespace in one part cannot combine
 * with `attachedTemplate` text in another and become a false positive.
 */
export const attachedTemplateScanner: Scanner = {
  async scan(bytes) {
    if (!hasZipMagic(bytes)) {
      return [];
    }

    const loaded = await Result.tryPromise({
      try: async () => await JSZip.loadAsync(bytes),
      catch: (cause) => cause,
    });
    if (Result.isError(loaded)) {
      return [];
    }
    const zip = loaded.value;

    const entries = Object.values(zip.files);
    if (entries.length > MAX_ARCHIVE_ENTRIES) {
      // The zip-bomb guard owns this rejection and reports its exact limit.
      return [];
    }

    let remainingBytes = MAX_RELATIONSHIPS_TOTAL_BYTES;
    for (const entry of entries) {
      if (entry.dir || !entry.name.endsWith(".rels")) {
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
              sanitizeAttachedTemplateRelationships(read.xml, entry.name),
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
