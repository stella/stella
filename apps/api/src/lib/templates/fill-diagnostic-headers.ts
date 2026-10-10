/**
 * The response headers a template download carries for its fill diagnostics.
 * Both download routes (a raw upload and a stored template by id) set them
 * from this one table, which is total over the diagnostic kinds: a new kind
 * has to say how a download reports it.
 */

import {
  CLAUSE_WARNINGS_HEADER,
  UNDECIDED_CONDITIONS_HEADER,
} from "@stll/api-contract/template-fill-headers";

import { FILL_DIAGNOSTIC_KINDS } from "@/api/lib/templates/template-fill-completion";
import type {
  FillDiagnosticKind,
  FillDiagnostics,
} from "@/api/lib/templates/template-fill-completion";

type DownloadFormat = "docx" | "pdf";

type DiagnosticHeader = {
  name: string;
  /** Formats whose response carries the header. */
  formats: readonly DownloadFormat[];
  /** Headers are ISO-8859-1, and field paths and messages carry diacritics
   *  and punctuation outside it, so every value is URI-encoded. */
  value: (diagnostics: FillDiagnostics) => string;
};

const ALL_FORMATS = ["docx", "pdf"] as const;
const DOCX_ONLY = ["docx"] as const;

const FILL_DIAGNOSTIC_HEADERS = {
  unmatchedPlaceholders: {
    name: "X-Unmatched-Placeholders",
    formats: DOCX_ONLY,
    value: (d) => encodeURIComponent(d.unmatchedPlaceholders.join(",")),
  },
  aiFieldErrors: {
    name: "X-Ai-Field-Errors",
    formats: ALL_FORMATS,
    value: (d) => encodeURIComponent(JSON.stringify(d.aiFieldErrors)),
  },
  undecidedConditions: {
    name: UNDECIDED_CONDITIONS_HEADER,
    formats: ALL_FORMATS,
    value: (d) =>
      encodeURIComponent(
        JSON.stringify(
          d.undecidedConditions.map(({ path, label, reason }) => ({
            path,
            label,
            reason,
          })),
        ),
      ),
  },
  // Only a count: the JSON results and receipts carry the warnings.
  clauseWarnings: {
    name: CLAUSE_WARNINGS_HEADER,
    formats: ALL_FORMATS,
    value: (d) => String(d.clauseWarnings.length),
  },
  structureErrors: {
    name: "X-Structure-Errors",
    formats: DOCX_ONLY,
    value: (d) => encodeURIComponent(JSON.stringify(d.structureErrors)),
  },
  unusedValues: {
    name: "X-Unused-Values",
    formats: DOCX_ONLY,
    value: (d) => encodeURIComponent(d.unusedValues.join(",")),
  },
  // Only a fill behind an anonymizing boundary has any; a download route has
  // none, but a download that did would name them.
  unrestoredFields: {
    name: "X-Unrestored-Fields",
    formats: ALL_FORMATS,
    value: (d) => encodeURIComponent(d.unrestoredFields.join(",")),
  },
} as const satisfies Record<FillDiagnosticKind, DiagnosticHeader>;

/** The diagnostic headers of a download in `format`, one per non-empty kind. */
export const fillDiagnosticHeaders = ({
  diagnostics,
  format,
}: {
  diagnostics: FillDiagnostics;
  format: DownloadFormat;
}): Headers => {
  const headers = new Headers();
  for (const kind of FILL_DIAGNOSTIC_KINDS) {
    const header: DiagnosticHeader = FILL_DIAGNOSTIC_HEADERS[kind];
    if (diagnostics[kind].length > 0 && header.formats.includes(format)) {
      headers.set(header.name, header.value(diagnostics));
    }
  }
  return headers;
};
