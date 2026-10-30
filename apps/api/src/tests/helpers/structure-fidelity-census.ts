/**
 * Structure-fidelity findings over every adapter's recorded fixtures.
 *
 * The fixtures are the ones the parser-output harness already replays through
 * each adapter's current parser (`scripts/parser-output-fixtures.ts`), so the
 * census reads exactly what ingestion would store from them. The guard test
 * holds the census to a shrink-only baseline;
 * `apps/api/scripts/update-structure-fidelity-baseline.ts` writes it.
 */

import { fileURLToPath } from "node:url";

import { isDocumentAst } from "@stll/legal-ast/document-ast";

import { structureFidelityIn } from "@/api/lib/legal-search/parsers/structure-fidelity";
import { isRecord } from "@/api/lib/type-guards";
import type { StructureFidelityCensus } from "@/api/tests/helpers/structure-fidelity-baseline";

import { collectParserOutputs } from "../../../../../scripts/parser-output-fixtures.ts";

export type StructureFidelityCensusResult = {
  census: StructureFidelityCensus;
  /** Adapters with at least one recorded fixture that yields a document. */
  documentedAdapters: ReadonlySet<string>;
};

export const structureFidelityRepositoryRoot = (moduleUrl: string) =>
  fileURLToPath(new URL("../../../../../", moduleUrl));

const REPOSITORY_ROOT = structureFidelityRepositoryRoot(import.meta.url);

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
): StructureFidelityCensus[string][string] | null => {
  const { documentAst, fulltext } = decision;
  if (!isDocumentAst(documentAst)) {
    return typeof fulltext === "string" && fulltext.trim().length > 0
      ? [
          {
            rule: "ast-missing",
            anchorId: "document",
            excerpt: fulltext.slice(0, 120),
          },
        ]
      : null;
  }
  return structureFidelityIn(documentAst.blocks);
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
        if (findings.length === 0) {
          continue;
        }
        const rows = census[adapter] ?? {};
        rows[fixture] = findings;
        census[adapter] = rows;
      }
    }
    return { census, documentedAdapters };
  };
