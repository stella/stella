import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { caseLawCitations } from "@/api/db/schema";
import { runCitationGraphTransaction } from "@/api/handlers/case-law/citation-graph-transaction";
import { citationTextRevisionFence as fence } from "@/api/handlers/case-law/polarity/text-revision";

type FixtureTx = {
  execute: (statement: SQL) => Promise<unknown>;
  update: (table: typeof caseLawCitations) => {
    set: (values: Partial<typeof caseLawCitations.$inferInsert>) => {
      where: (condition: SQL) => void;
    };
  };
};
type Windows = NonNullable<
  typeof caseLawCitations.$inferInsert.polarityEvidenceWindows
>;
type Evidence = { windows: Windows; revision: Parameters<typeof fence>[0] };

const unguarded = (tx: FixtureTx, evidence: Evidence) => {
  const windows = evidence.windows;
  // oxlint-disable-next-line citation-evidence-text-fence/citation-evidence-text-fence -- fixture: imported fence alone does not guard a writer
  tx.update(caseLawCitations).set({ polarityEvidenceWindows: windows });
};
const guarded = (tx: FixtureTx, evidence: Evidence) => {
  const windows = evidence.windows;
  return runCitationGraphTransaction(
    (run) => run(tx),
    (graphTx) => {
      const revision = fence(evidence.revision);
      // expect-clean: citation-evidence-text-fence/citation-evidence-text-fence
      graphTx
        .update(caseLawCitations)
        .set({ polarityEvidenceWindows: windows })
        .where(revision);
    },
  );
};
const separateGraphCall = (tx: FixtureTx, evidence: Evidence) => {
  runCitationGraphTransaction(
    (run) => run(tx),
    () => fence(evidence.revision),
  );
  // oxlint-disable-next-line citation-evidence-text-fence/citation-evidence-text-fence -- fixture: a separate graph callback does not own this mutation
  tx.update(caseLawCitations).set({
    polarityConfidence: evidence.windows.length,
  });
};
const clear = (tx: FixtureTx) => {
  // expect-clean: citation-evidence-text-fence/citation-evidence-text-fence
  tx.update(caseLawCitations).set({ polarityEvidenceWindows: null });
};
const raw = async (tx: FixtureTx, windows: Windows) => {
  // oxlint-disable-next-line citation-evidence-text-fence/citation-evidence-text-fence -- fixture: raw SQL requires the same owner fence
  const mutation = sql`UPDATE case_law_citations SET polarity_evidence_windows = ${JSON.stringify(windows)}`;
  await tx.execute(mutation);
};
const guardedRaw = async (tx: FixtureTx, evidence: Evidence) =>
  runCitationGraphTransaction(
    (run) => run(tx),
    async (graphTx) => {
      const revision = fence(evidence.revision);
      const windows = evidence.windows;
      // expect-clean: citation-evidence-text-fence/citation-evidence-text-fence
      const mutation = sql`UPDATE case_law_citations SET polarity_evidence_windows = ${JSON.stringify(windows)}`;
      await graphTx.execute(sql`${mutation} WHERE ${revision}`);
    },
  );
export { unguarded, guarded, separateGraphCall, clear, raw, guardedRaw };
