/**
 * Retention projection for the Polish Supreme Court (sn.pl).
 *
 * The stored raw is an envelope of the proxy's answers for one decision:
 * `listing` (the listing row), `detail` (the detail record) and, where the
 * proxy served one, `document`. Every answer wraps its payload twice, as
 * `{ data: [{ data: payload }] }`; the document's payload carries the
 * decision's PDF base64-encoded under `raw`.
 *
 * The decision text exists only inside that PDF, so the projection decodes
 * it and reads its lines with the PDF library itself (`pdf-text.ts`), never
 * through the parser's reader: the comparison is against every line the
 * file states. A decision without a PDF is one the proxy served no document
 * for.
 */
import { Result } from "better-result";

import {
  RETENTION_PROJECTION_FAILURE,
  RETENTION_TEXT_ABSENCE,
  type RetentionPolicy,
  type RetentionProjection,
} from "@/api/handlers/case-law/ingestion/retention/retention-policy";
import { projectPdfText } from "@/api/handlers/case-law/ingestion/retention/sources/pdf-text";
import { decodeSourceRawEnvelope } from "@/api/lib/legal-search/source-raw-envelope";
import { isRecord } from "@/api/lib/type-guards";

const DOCUMENT_PART = "document";

/** The payload inside the proxy's double wrapping, or null for none. */
const proxyPayload = (value: unknown): unknown => {
  const outer = isRecord(value) ? value["data"] : undefined;
  const inner: unknown = Array.isArray(outer) ? outer.at(0) : undefined;
  return isRecord(inner) ? inner["data"] : null;
};

const projectPlSn = async (sourceRaw: string): Promise<RetentionProjection> => {
  const parts = decodeSourceRawEnvelope(sourceRaw);
  if (parts === null) {
    return {
      type: "unreadable",
      reason: RETENTION_PROJECTION_FAILURE.UNREADABLE_ENVELOPE,
    };
  }
  const documentPart = parts[DOCUMENT_PART];
  if (documentPart === undefined) {
    return { type: "no-text", reason: RETENTION_TEXT_ABSENCE.NOT_PUBLISHED };
  }
  const answer = Result.try({
    try: (): unknown => JSON.parse(documentPart),
    catch: () => null,
  }).unwrapOr(null);
  if (answer === null) {
    return {
      type: "unreadable",
      reason: RETENTION_PROJECTION_FAILURE.UNREADABLE_ENVELOPE,
    };
  }
  const payload = proxyPayload(answer);
  const pdf = isRecord(payload) ? payload["raw"] : undefined;
  if (typeof pdf !== "string" || pdf.length === 0) {
    return { type: "no-text", reason: RETENTION_TEXT_ABSENCE.NOT_PUBLISHED };
  }
  const bytes = Result.try({
    try: () => Uint8Array.fromBase64(pdf),
    catch: (cause) => cause,
  });
  return Result.isOk(bytes)
    ? await projectPdfText(bytes.value)
    : {
        type: "unreadable",
        reason: RETENTION_PROJECTION_FAILURE.UNREADABLE_DOCUMENT,
      };
};

export const plSnRetention: RetentionPolicy = {
  type: "checked",
  project: projectPlSn,
};
