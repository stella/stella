import { Result } from "better-result";

import {
  ATTACHED_TEMPLATE_SECURITY_RULE,
  isOpcRelationshipPartPath,
  loadDocx,
  repackZip,
  sanitizeAttachedTemplateRelationships,
  sanitizeAttachedTemplateSource,
  type AttachedTemplateTargetKind,
} from "@stll/docx-utils";

import { isDocxFile } from "@/lib/consts";

const MAX_INSPECTED_DOCX_BYTES = 50 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 1000;
const MAX_RELATIONSHIPS_ENTRY_BYTES = 1024 * 1024;
const MAX_RELATIONSHIPS_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_ATTACHED_TEMPLATE_SOURCE_BYTES = 1024 * 1024;

export type PreparedAttachedTemplateFile = {
  file: File;
  id: `${string}-${string}-${string}-${string}-${string}`;
  originalFile: File;
  rule: typeof ATTACHED_TEMPLATE_SECURITY_RULE;
  targetKinds: readonly AttachedTemplateTargetKind[];
};

const declaredUncompressedSize = (value: unknown): number | null => {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  if (!("_data" in value)) {
    return null;
  }
  const data = value._data;
  if (typeof data !== "object" || data === null) {
    return null;
  }
  if (!("uncompressedSize" in data)) {
    return null;
  }
  const size = data.uncompressedSize;
  return typeof size === "number" && Number.isFinite(size) ? size : null;
};

/**
 * Prepare a safe copy of a DOCX that carries an attached-template link.
 * Returns null for clean, non-DOCX, oversized, or unreadable input. The API
 * remains authoritative and rejects an attached template if this preflight
 * cannot inspect the file.
 */
export const prepareAttachedTemplateFile = async (
  originalFile: File,
): Promise<PreparedAttachedTemplateFile | null> => {
  if (
    !isDocxFile(originalFile) ||
    originalFile.size > MAX_INSPECTED_DOCX_BYTES
  ) {
    return null;
  }

  const prepared = await Result.tryPromise({
    try: async (): Promise<PreparedAttachedTemplateFile | null> => {
      const zip = await loadDocx(await originalFile.arrayBuffer());
      const entries = Object.values(zip.files);
      if (entries.length > MAX_ARCHIVE_ENTRIES) {
        return null;
      }

      const targetKinds = new Set<AttachedTemplateTargetKind>();
      const sourceRelationshipIds = new Map<string, Set<string>>();
      let relationshipBytes = 0;

      for (const entry of entries) {
        if (entry.dir || !isOpcRelationshipPartPath(entry.name)) {
          continue;
        }
        const declaredSize = declaredUncompressedSize(entry);
        if (
          declaredSize === null ||
          declaredSize > MAX_RELATIONSHIPS_ENTRY_BYTES ||
          relationshipBytes + declaredSize > MAX_RELATIONSHIPS_TOTAL_BYTES
        ) {
          return null;
        }
        relationshipBytes += declaredSize;

        const xml = await entry.async("string");
        if (
          new TextEncoder().encode(xml).byteLength >
          MAX_RELATIONSHIPS_ENTRY_BYTES
        ) {
          return null;
        }
        const sanitized = sanitizeAttachedTemplateRelationships(
          xml,
          entry.name,
        );
        if (sanitized.findings.length === 0) {
          continue;
        }
        if (
          sanitized.sourcePartPath === null ||
          sanitized.removedRelationshipIds.length !==
            sanitized.findings.length
        ) {
          return null;
        }
        zip.file(entry.name, sanitized.xml);
        for (const finding of sanitized.findings) {
          targetKinds.add(finding.targetKind);
        }
        const relationshipIds =
          sourceRelationshipIds.get(sanitized.sourcePartPath) ?? new Set();
        for (const relationshipId of sanitized.removedRelationshipIds) {
          relationshipIds.add(relationshipId);
        }
        sourceRelationshipIds.set(sanitized.sourcePartPath, relationshipIds);
      }

      if (targetKinds.size === 0) {
        return null;
      }

      for (const [sourcePartPath, relationshipIds] of sourceRelationshipIds) {
        const source = zip.file(sourcePartPath);
        if (source === null) {
          continue;
        }
        const declaredSize = declaredUncompressedSize(source);
        if (
          declaredSize === null ||
          declaredSize > MAX_ATTACHED_TEMPLATE_SOURCE_BYTES
        ) {
          return null;
        }
        const sourceXml = await source.async("string");
        if (
          new TextEncoder().encode(sourceXml).byteLength >
          MAX_ATTACHED_TEMPLATE_SOURCE_BYTES
        ) {
          return null;
        }
        const sanitized = sanitizeAttachedTemplateSource(sourceXml, [
          ...relationshipIds,
        ]);
        if (sanitized.removed > 0) {
          zip.file(sourcePartPath, sanitized.xml);
        }
      }

      const bytes = await repackZip(zip);
      return {
        file: new File([bytes], originalFile.name, {
          type: originalFile.type,
          lastModified: originalFile.lastModified,
        }),
        id: crypto.randomUUID(),
        originalFile,
        rule: ATTACHED_TEMPLATE_SECURITY_RULE,
        targetKinds: [...targetKinds],
      };
    },
    catch: (cause) => cause,
  });
  if (Result.isError(prepared)) {
    return null;
  }
  return prepared.value;
};

export const prepareAttachedTemplateFiles = async (
  files: readonly File[],
): Promise<readonly PreparedAttachedTemplateFile[]> => {
  const prepared: PreparedAttachedTemplateFile[] = [];
  // Deliberately serial: a batch can contain several 50 MB DOCX files, and
  // inflating them concurrently would multiply the tab's peak memory use.
  for (const file of files) {
    const result = await prepareAttachedTemplateFile(file);
    if (result !== null) {
      prepared.push(result);
    }
  }
  return prepared;
};
