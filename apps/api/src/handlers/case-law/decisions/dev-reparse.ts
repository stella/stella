/**
 * Development only: re-parse a decision from the publisher on read.
 *
 * Reading a shared corpus through the read-only handle shows the text as
 * it was parsed when it was ingested, so parser work is invisible until a
 * re-ingestion runs elsewhere. In that mode, and only when the process is
 * a development one, a Czech NSS decision is fetched from the publisher
 * and parsed with the parser in this tree; the result replaces the stored
 * document for the response and is kept in memory for the process. Nothing
 * is written anywhere, and a fetch that fails leaves the stored document.
 */

import type { DocumentAst } from "@stll/legal-ast/document-ast";

import { envBase } from "@/api/env-base";
import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import { courtFromEcli } from "@/api/handlers/case-law/ingestion/adapters/cz-nss";
import { parseNssDecisionHtml } from "@/api/handlers/case-law/ingestion/parsers/cz-nss";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { fetchWithTimeout } from "@/api/lib/fetch";

const FETCH_TIMEOUT_MS = 20_000;

/** The publisher's origin, a literal so the outbound target is provable. */
const NSS_BASE_URL = "https://vyhledavac.nssoud.cz";

/** The publisher's own id, the only part of a stored URL that is used. */
const NSS_DOCUMENT_ID = /\/DokumentDetail\/Index\/(?<id>\d+)(?:[/?#]|$)/u;

/** Only a development process reading a shared corpus re-parses on read. */
export const devReparseEnabled = (): boolean =>
  envBase.isDev && envBase.PUBLIC_LAW_DATABASE_URL !== undefined;

export type DevReparseDecision = {
  id: SafeId<"caseLawDecision">;
  adapterKey: string;
  caseNumber: string;
  court: string;
  decisionDate: string | null;
  decisionType: string | null;
  documentUrl: string | null;
  ecli: string | null;
  metadata: Record<string, unknown> | null;
};

const parsed = new Map<
  SafeId<"caseLawDecision">,
  Promise<DocumentAst | null>
>();

const reparseNss = async (
  decision: DevReparseDecision,
): Promise<DocumentAst | null> => {
  const documentId = NSS_DOCUMENT_ID.exec(decision.documentUrl ?? "")?.groups?.[
    "id"
  ];
  if (documentId === undefined) {
    return null;
  }
  const response = await fetchWithTimeout(
    `${NSS_BASE_URL}/DokumentOriginal/Html/${documentId}`,
    { timeoutMs: FETCH_TIMEOUT_MS },
  );
  if (!response.ok) {
    return null;
  }
  const html = await response.text();
  if (html.length < 200) {
    return null;
  }
  const ecli = decision.ecli ?? undefined;
  const { documentAst } = parseNssDecisionHtml({
    caseNumber: decision.caseNumber,
    court: courtFromEcli(ecli) || decision.court,
    decisionDate: decision.decisionDate ?? undefined,
    decisionType: decision.decisionType ?? undefined,
    detailMetadata: decision.metadata ?? {},
    ecli,
    html,
    sourceUrl: decision.documentUrl ?? undefined,
  });
  // Not run through the ingestion sanitizer: this is a development view of
  // the parser's own output, and the reader's rendering is what is being
  // looked at.
  return documentAst;
};

/**
 * The decision's document as the current parser reads it, or null when
 * the source is not one this re-parses or the publisher did not answer.
 */
export const reparseForDev = async (
  decision: DevReparseDecision,
): Promise<DocumentAst | null> => {
  if (decision.adapterKey !== ADAPTER_KEYS.CZ_NSS) {
    return null;
  }
  const pending = parsed.get(decision.id);
  if (pending !== undefined) {
    return await pending;
  }
  const attempt = reparseNss(decision).catch((error: unknown) => {
    captureError(error, {
      source: "case-law-dev-reparse",
      decisionId: decision.id,
    });
    parsed.delete(decision.id);
    return null;
  });
  parsed.set(decision.id, attempt);
  return await attempt;
};
