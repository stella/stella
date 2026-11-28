/**
 * ScannedFile wrapper around `@stll/docx-engine/clause-slots`.
 */

import {
  type ClauseSlot,
  discoverClauseSlotsFromBytes,
} from "@stll/docx-engine/clause-slots";

import type { ScannedFile } from "@/api/lib/file-scan/scanned-file";

/**
 * Discover all `{{ clause(...) }}` markers in a DOCX
 * template. Scans body, headers, and footers.
 */
export const discoverClauseSlots = async (
  file: ScannedFile,
): Promise<ClauseSlot[]> => discoverClauseSlotsFromBytes(file.bytes);
