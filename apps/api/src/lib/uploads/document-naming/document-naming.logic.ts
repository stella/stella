import * as v from "valibot";

import { apiDateSchema } from "@stll/api-contract/api-date";
import type { DocumentNameValues } from "@stll/api-contract/document-name";

/** A document shorter than this carries too little to name it from. */
export const NAMING_TEXT_MIN_CHARS = 40;
const NAMING_TEXT_CAP_CHARS = 6000;
const DOC_TYPE_MAX_CHARS = 60;
const TITLE_MAX_CHARS = 120;

export const documentNamingSchema = v.object({
  date: v.nullable(apiDateSchema),
  docType: v.nullable(
    v.pipe(v.string(), v.trim(), v.maxLength(DOC_TYPE_MAX_CHARS)),
  ),
  title: v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(TITLE_MAX_CHARS))),
});

export type DocumentNaming = v.InferOutput<typeof documentNamingSchema>;

export const DOCUMENT_NAMING_SYSTEM_PROMPT =
  "Describe a legal document so it can be filed under a standard name. " +
  "Return its own date (the date it was signed, issued, filed or decided) as an ISO date, " +
  `its document type in one to three words (for example Contract, Ruling, Invoice, Power of attorney; at most ${DOC_TYPE_MAX_CHARS} characters), ` +
  `and a short descriptive title of at most ${TITLE_MAX_CHARS} characters that does not repeat the type or the date. ` +
  "Write the type and title in the document's own language. " +
  "Use null for anything the document does not state; never guess a date.";

export const namingPrompt = (name: string, text: string): string =>
  `File name: "${name}"\n\n${text.slice(0, NAMING_TEXT_CAP_CHARS)}`;

/** The name's extension with its dot, or "" when it has none. */
export const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot) : "";
};

export const namingValues = (
  naming: DocumentNaming,
  matterNumber: string,
): DocumentNameValues => ({
  date: naming.date,
  docType: naming.docType,
  matterNumber,
  title: naming.title,
});
