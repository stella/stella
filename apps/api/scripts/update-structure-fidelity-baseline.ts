/**
 * Rewrite the structure-fidelity baseline from the current parsers.
 *
 * The baseline only shrinks: run this after a parser change removed findings,
 * never to accept new ones. A new finding is a parser defect to fix through
 * the shared owners (`hard-wrapped-lines.ts`, `page-furniture.ts`,
 * `letter-spacing.ts`).
 *
 * Usage: bun apps/api/scripts/update-structure-fidelity-baseline.ts
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertStructureFidelityBaselineHistory,
  STRUCTURE_FIDELITY_BASELINE_PATH,
} from "@/api/tests/helpers/structure-fidelity-baseline";
import { collectStructureFidelityCensus } from "@/api/tests/helpers/structure-fidelity-census";

type UpdateStructureFidelityBaselineOptions = {
  repositoryRoot?: string;
  baseRevision?: string;
  collectCensus?: typeof collectStructureFidelityCensus;
};

export const updateStructureFidelityBaseline = async ({
  repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url)),
  collectCensus = collectStructureFidelityCensus,
  baseRevision,
}: UpdateStructureFidelityBaselineOptions = {}) => {
  const { census } = await collectCensus();
  assertStructureFidelityBaselineHistory({
    repositoryRoot,
    ...(baseRevision === undefined ? {} : { baseRevision }),
    findings: census,
  });
  await Bun.write(
    path.join(repositoryRoot, STRUCTURE_FIDELITY_BASELINE_PATH),
    `${JSON.stringify(
      {
        comment:
          "Structure-fidelity findings per adapter and recorded fixture (structure-fidelity.ts). Shrink-only: a new finding fails the guard; a fixed one must be removed with apps/api/scripts/update-structure-fidelity-baseline.ts.",
        findings: census,
      },
      null,
      2,
    )}
`,
  );
};

if (import.meta.main) {
  await updateStructureFidelityBaseline();
}
