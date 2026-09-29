import { rootDb } from "@/api/db/root";
import { persistManualOcrRun } from "@/api/lib/document-processing-request";
import type { PersistManualOcrRunOptions } from "@/api/lib/document-processing-request";

/**
 * Record a user's manual OCR request for a document version.
 *
 * The request may collide with a run another requester or an upload already
 * owns: it then promotes, retries or reuses that run and cancels competing
 * manual selections, all in one serialized transaction with the entity
 * locked. Those rows are not the caller's to update under its own scope, so
 * this one operation runs on the owner connection.
 */
export const persistRequestedManualOcrRun = async (
  options: Omit<PersistManualOcrRunOptions, "db">,
) => await persistManualOcrRun({ ...options, db: rootDb });
