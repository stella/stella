/**
 * Retention projection for the Brazilian Superior Labour Court (TST).
 *
 * The adapter stores the search record it was served, verbatim, as the
 * envelope's `listing` part. The record carries its own text, chosen by its
 * type (`tipo.codigoTipoJurisprudencia`):
 *
 * - an acórdão's full text is the HTML under `inteiroTeorHtml`;
 * - a despacho's text is `txtConteudoDecisao`, either HTML wrapped in a
 *   literal CDATA section or plain lines;
 * - a súmula, OJ or precedente normativo is printed from `titulo`, `tese`,
 *   `observacao` and `historico`, each a run of HTML fragments, one per line.
 *
 * The backend serves the literal "removido no backend" in place of a field it
 * strips, which is the publisher saying the text is not here. A record whose
 * type states none of its text is one the publisher served without text.
 */
import { Result } from "better-result";

import {
  RETENTION_PROJECTION_FAILURE,
  RETENTION_TEXT_ABSENCE,
  type RetentionPolicy,
  type RetentionProjection,
} from "@/api/handlers/case-law/ingestion/retention/retention-policy";
import { htmlParagraphs } from "@/api/handlers/case-law/ingestion/retention/sources/html-paragraphs";
import { decodeSourceRawEnvelope } from "@/api/lib/legal-search/source-raw-envelope";
import { isRecord } from "@/api/lib/type-guards";

/** The envelope part the search record is stored under. */
const LISTING_PART = "listing";

/** The literal the backend serves in place of the fields it strips. */
const PLACEHOLDER = "removido no backend";

const CDATA_OPEN = "<![CDATA[";
const CDATA_CLOSE = "]]>";

const PRECEDENT_FIELDS = ["titulo", "tese", "observacao", "historico"] as const;

/** A field's text, or nothing where it is empty or the backend's placeholder. */
const textOf = (value: unknown): string | undefined =>
  typeof value === "string" &&
  value.trim() !== "" &&
  value.trim() !== PLACEHOLDER
    ? value
    : undefined;

/** Every line of a field, each read as the HTML fragment it is. */
const fragmentParagraphs = (value: string): string[] =>
  value.split(/\r?\n/u).flatMap((line) => htmlParagraphs(line));

const plainParagraphs = (value: string): string[] =>
  value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

const despachoParagraphs = (value: string): string[] => {
  const trimmed = value.trim();
  return trimmed.startsWith(CDATA_OPEN) && trimmed.endsWith(CDATA_CLOSE)
    ? htmlParagraphs(trimmed.slice(CDATA_OPEN.length, -CDATA_CLOSE.length))
    : plainParagraphs(value);
};

/** The record's text as the publisher served it, or null when it has none. */
const recordParagraphs = (record: Record<string, unknown>): string[] | null => {
  const tipo = record["tipo"];
  const code = isRecord(tipo) ? tipo["codigoTipoJurisprudencia"] : undefined;
  switch (code) {
    case "ACORDAO": {
      const html = textOf(record["inteiroTeorHtml"]);
      return html === undefined ? null : htmlParagraphs(html);
    }
    case "DESPACHO": {
      const text = textOf(record["txtConteudoDecisao"]);
      return text === undefined ? null : despachoParagraphs(text);
    }
    case "SUM":
    case "OJ":
    case "OJT":
    case "PN": {
      const fields = PRECEDENT_FIELDS.flatMap((field) => {
        const text = textOf(record[field]);
        return text === undefined ? [] : [text];
      });
      return fields.length === 0 ? null : fields.flatMap(fragmentParagraphs);
    }
    default:
      // A type the adapter does not build is kept as a listing-only row and
      // never reaches the check with a usable AST.
      return null;
  }
};

const projectBrTst = (sourceRaw: string): RetentionProjection => {
  const parts = decodeSourceRawEnvelope(sourceRaw);
  if (parts === null) {
    return {
      type: "unreadable",
      reason: RETENTION_PROJECTION_FAILURE.UNREADABLE_ENVELOPE,
    };
  }
  const listing = parts[LISTING_PART];
  if (listing === undefined) {
    return {
      type: "unreadable",
      reason: RETENTION_PROJECTION_FAILURE.MISSING_TEXT_PART,
    };
  }
  const record = Result.try({
    try: (): unknown => JSON.parse(listing),
    catch: () => null,
  }).unwrapOr(null);
  if (!isRecord(record)) {
    return {
      type: "unreadable",
      reason: RETENTION_PROJECTION_FAILURE.UNREADABLE_ENVELOPE,
    };
  }
  const paragraphs = recordParagraphs(record);
  return paragraphs === null
    ? { type: "no-text", reason: RETENTION_TEXT_ABSENCE.NOT_PUBLISHED }
    : { type: "source", source: { type: "paragraphs", paragraphs } };
};

export const brTstRetention = {
  type: "checked",
  project: async (sourceRaw) => await Promise.resolve(projectBrTst(sourceRaw)),
} as const satisfies RetentionPolicy;
