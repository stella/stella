/**
 * Structure-fidelity findings over every adapter's recorded fixtures.
 *
 * The fixtures are the ones the parser-output harness already replays through
 * each adapter's current parser (`scripts/parser-output-fixtures.ts`), so the
 * census reads exactly what ingestion would store from them. The guard test
 * holds the census to a shrink-only baseline;
 * `apps/api/scripts/update-structure-fidelity-baseline.ts` writes it.
 */

import { isDocumentAst } from "@stll/legal-ast/document-ast";

import {
  STRUCTURE_FIDELITY_RULES,
  structureFidelityIn,
} from "@/api/lib/legal-search/parsers/structure-fidelity";
import type { StructureFidelityRule } from "@/api/lib/legal-search/parsers/structure-fidelity";
import { isRecord } from "@/api/lib/type-guards";

import { collectParserOutputs } from "../../../../../scripts/parser-output-fixtures";

/**
 * Text stored without a readable AST: the parser emitted none, or the reader
 * schema rejected the one it emitted and only the text was kept.
 */
export const AST_MISSING_FINDING = "ast-missing";

export type StructureFidelityFindingKind =
  StructureFidelityRule | typeof AST_MISSING_FINDING;

export const STRUCTURE_FIDELITY_FINDING_KINDS = [
  ...Object.values(STRUCTURE_FIDELITY_RULES),
  AST_MISSING_FINDING,
] as const satisfies readonly StructureFidelityFindingKind[];

/** Non-zero finding counts, per adapter, per fixture. */
export type StructureFidelityCensus = Record<
  string,
  Record<string, Partial<Record<StructureFidelityFindingKind, number>>>
>;

export type StructureFidelityCensusResult = {
  census: StructureFidelityCensus;
  /** Adapters with at least one recorded fixture that yields a document. */
  documentedAdapters: ReadonlySet<string>;
};

const REPOSITORY_ROOT = new URL("../../../../../", import.meta.url).pathname;

/** The persisted decision of an output: a decision, or a supplement's document. */
const decisionOf = (output: unknown): Record<string, unknown> | null => {
  if (!isRecord(output)) {
    return null;
  }
  const document = output["document"];
  return isRecord(document) ? document : output;
};

const findingsOf = (
  decision: Record<string, unknown>,
): Partial<Record<StructureFidelityFindingKind, number>> | null => {
  const { documentAst, fulltext } = decision;
  if (!isDocumentAst(documentAst)) {
    return typeof fulltext === "string" && fulltext.trim().length > 0
      ? { [AST_MISSING_FINDING]: 1 }
      : null;
  }
  const counts: Partial<Record<StructureFidelityFindingKind, number>> = {};
  for (const { rule } of structureFidelityIn(documentAst.blocks)) {
    counts[rule] = (counts[rule] ?? 0) + 1;
  }
  return counts;
};

export const collectStructureFidelityCensus =
  async (): Promise<StructureFidelityCensusResult> => {
    const outputs = await collectParserOutputs(REPOSITORY_ROOT);
    const census: StructureFidelityCensus = {};
    const documentedAdapters = new Set<string>();
    for (const [adapter, fixtures] of Object.entries(outputs)) {
      for (const [fixture, output] of Object.entries(fixtures)) {
        const decision = decisionOf(output);
        const findings = decision === null ? null : findingsOf(decision);
        if (findings === null) {
          continue;
        }
        documentedAdapters.add(adapter);
        if (Object.keys(findings).length === 0) {
          continue;
        }
        const rows = census[adapter] ?? {};
        rows[fixture] = findings;
        census[adapter] = rows;
      }
    }
    return { census, documentedAdapters };
  };
