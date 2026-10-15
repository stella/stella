/**
 * Bring the seeded case-law fixtures' parsed output up to the current
 * parsers, row by row.
 *
 * - A row recorded with its raw source (`source_raw`) is re-parsed through its
 *   adapter's `reparseStoredRaw`, sanitized the way ingestion stores it, and
 *   takes the new `document_ast`, `sections`, `fulltext` and
 *   `parser_version`.
 * - A row exported without raw keeps its stored document; only the read-time
 *   repairs (`parseCaseLawDecisionAst`) are applied to its AST, so the stored
 *   form matches what every reader already sees. Its `parser_version` stays.
 *
 * A stored analysis is a claim about one exact model input. When a row's new
 * document changes that input, the row fails: re-stamping the fingerprint
 * would certify a tree whose anchors may no longer exist. Rerun the analysis,
 * or keep that decision's parse stable.
 *
 * Comparison is semantic (key order and whitespace ignored), so archives are
 * rewritten only when a row's content changes.
 */

import { panic, Result } from "better-result";

import { parseCaseLawDecisionAst } from "@stll/legal-ast/case-law-reader";

import { getSystemPrompt } from "@/api/handlers/case-law/analysis/prompts/prompt-registry";
import { analysisInputOf } from "@/api/lib/case-law/analysis-prompt";
import type {
  StoredRawReparseInput,
  StoredRawReparseOutcome,
} from "@/api/lib/legal-search/ingestion-types";

/** The fixture row fields this module reads or rewrites; others pass through. */
export type ReparseFixtureRow = {
  case_number: string;
  court: string;
  country: string;
  language: string;
  ecli?: string | null;
  decision_date?: string | null;
  decision_type?: string | null;
  source_url?: string | null;
  document_url?: string | null;
  source_document_id?: string | null;
  metadata?: Record<string, unknown> | null;
  fulltext?: string | null;
  sections?: unknown;
  document_ast?: unknown;
  parser_version?: number | null;
  source_raw?: string | null;
  source_raw_content_type?: string | null;
  analysis?: { inputFingerprint?: unknown } | null;
};

/** What a re-parse of stored raw yields, already sanitized for storage. */
type ReparsedDocument = {
  documentAst: unknown;
  sections: unknown;
  fulltext: string | null;
  parserVersion: number | null;
};

export type RawReparser = (
  adapterKey: string,
  input: StoredRawReparseInput,
) => Promise<ReparsedDocument | { rejected: string }>;

export type RowResult =
  | { type: "unchanged" }
  | {
      type: "changed";
      row: ReparseFixtureRow;
      via: "reparsed" | "renormalized";
    }
  | { type: "failed"; message: string };

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .toSorted(([a], [b]) => Number(a > b) - Number(a < b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  // JSON.stringify drops an undefined array item to null; say so explicitly.
  if (value === undefined) {
    return "null";
  }
  return JSON.stringify(value);
};

/** Equal as stored JSON, whatever the key order. */
export const sameJson = (a: unknown, b: unknown) =>
  canonical(a) === canonical(b);

/** The analysis input fingerprint `row` would have with `documentAst`. */
const analysisFingerprint = (row: ReparseFixtureRow, documentAst: unknown) => {
  const ast = parseCaseLawDecisionAst(documentAst);
  if (ast === null) {
    return null;
  }
  const systemPrompt = getSystemPrompt(row.language);
  if (Result.isError(systemPrompt)) {
    return panic(`${row.case_number}: ${systemPrompt.error.message}`);
  }
  return analysisInputOf({
    blocks: ast.blocks,
    decision: {
      court: row.court,
      country: row.country,
      decisionType: row.decision_type ?? null,
      language: row.language,
    },
    systemPrompt: systemPrompt.value,
  }).fingerprint;
};

const storedInput = (
  row: ReparseFixtureRow,
  raw: string,
): StoredRawReparseInput => ({
  raw: new TextEncoder().encode(raw),
  contentType: row.source_raw_content_type ?? null,
  caseNumber: row.case_number,
  sourceDocumentId: row.source_document_id ?? null,
  language: row.language,
  court: row.court,
  ecli: row.ecli ?? null,
  decisionDate: row.decision_date ?? null,
  decisionType: row.decision_type ?? null,
  sourceUrl: row.source_url ?? null,
  documentUrl: row.document_url ?? null,
  metadata: row.metadata ?? {},
});

/** Re-parse or re-normalize one row; never touches its analysis. */
export const reparseFixtureRow = async ({
  adapterKey,
  row,
  reparse,
}: {
  adapterKey: string;
  row: ReparseFixtureRow;
  reparse: RawReparser;
}): Promise<RowResult> => {
  let next: ReparseFixtureRow;
  let via: "reparsed" | "renormalized";
  if (typeof row.source_raw === "string" && row.source_raw !== "") {
    const reparsed = await reparse(
      adapterKey,
      storedInput(row, row.source_raw),
    );
    if ("rejected" in reparsed) {
      return {
        type: "failed",
        message: `${row.case_number}: its recorded raw no longer parses (${reparsed.rejected})`,
      };
    }
    via = "reparsed";
    next = {
      ...row,
      document_ast: reparsed.documentAst,
      sections: reparsed.sections,
      fulltext: reparsed.fulltext,
      parser_version: reparsed.parserVersion,
    };
  } else {
    const normalized = parseCaseLawDecisionAst(row.document_ast);
    if (normalized === null) {
      // Nothing usable to repair; the row stays exactly as exported.
      return { type: "unchanged" };
    }
    via = "renormalized";
    next = { ...row, document_ast: normalized };
  }
  if (sameJson(next, row)) {
    return { type: "unchanged" };
  }
  const stored = row.analysis?.inputFingerprint;
  if (typeof stored === "string") {
    const before = analysisFingerprint(row, row.document_ast);
    const after = analysisFingerprint(next, next.document_ast);
    if (before !== after) {
      return {
        type: "failed",
        message:
          `${row.case_number}: the new parse changes the input of its stored analysis ` +
          `(${String(before).slice(0, 12)} -> ${String(after).slice(0, 12)}). ` +
          "Fingerprints are never re-stamped by this generator: rerun the analysis for this decision, or keep its parse stable.",
      };
    }
  }
  return { type: "changed", row: next, via };
};

/** The production re-parse: the adapter's own hook, then storage sanitizing. */
export const adapterReparser: RawReparser = async (adapterKey, input) => {
  const [{ loadAdapterByKey }, { sanitizeResult }, { decisionSections }] =
    await Promise.all([
      import("@/api/handlers/case-law/ingestion/adapters/adapter-registry-lazy"),
      import("@/api/lib/legal-search/ingestion-normalization"),
      import("@/api/handlers/case-law/ingestion/pipeline/corpus-mirror"),
    ]);
  const adapter = await loadAdapterByKey(adapterKey);
  if (!adapter?.reparseStoredRaw) {
    return { rejected: `adapter ${adapterKey} cannot re-parse stored raw` };
  }
  const outcome: StoredRawReparseOutcome =
    await adapter.reparseStoredRaw(input);
  if (outcome.type === "rejected") {
    return { rejected: `${outcome.rejection}: ${outcome.detail}` };
  }
  if (outcome.type === "supplement") {
    return { rejected: "the payload is a supplement" };
  }
  const result = sanitizeResult(outcome.result);
  const sections = decisionSections(result);
  return {
    documentAst: result.documentAst,
    sections: sections.length > 0 ? sections : null,
    fulltext: result.fulltext ?? null,
    parserVersion: result.parserVersion ?? null,
  };
};
