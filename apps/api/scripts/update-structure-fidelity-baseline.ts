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

import { collectStructureFidelityCensus } from "@/api/tests/helpers/structure-fidelity-census";

const BASELINE = new URL(
  "../src/handlers/case-law/ingestion/parsers/structure-fidelity-baseline.json",
  import.meta.url,
);

const { census } = await collectStructureFidelityCensus();
await Bun.write(
  BASELINE,
  `${JSON.stringify(
    {
      comment:
        "Structure-fidelity findings per adapter and recorded fixture (structure-fidelity.ts). Shrink-only: a new finding fails the guard; a fixed one must be removed with apps/api/scripts/update-structure-fidelity-baseline.ts.",
      findings: census,
    },
    null,
    2,
  )}\n`,
);
