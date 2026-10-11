import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { caseLawCitations } from "@/api/db/schema";
import { runCitationGraphTransaction } from "@/api/handlers/case-law/citation-graph-transaction";
import { citationTextRevisionFence as fence } from "@/api/lib/case-law/text-revision";

type FixtureTx = {
  execute: (statement: SQL) => Promise<unknown>;
  update: (table: typeof caseLawCitations) => {
    set: (values: Partial<typeof caseLawCitations.$inferInsert>) => {
      where: (condition: SQL) => void;
    };
  };
};
type Evidence = { start: number; revision: Parameters<typeof fence>[0] };

const unguarded = (tx: FixtureTx, evidence: Evidence) => {
  // oxlint-disable-next-line citation-evidence-text-fence/citation-evidence-text-fence -- fixture: imported fence alone does not guard a writer
  tx.update(caseLawCitations).set({ polarityWindowStart: evidence.start });
};
const guarded = (tx: FixtureTx, evidence: Evidence) =>
  runCitationGraphTransaction(
    (run) => run(tx),
    (graphTx) => {
      const revision = fence(evidence.revision);
      // expect-clean: citation-evidence-text-fence/citation-evidence-text-fence
      graphTx
        .update(caseLawCitations)
        .set({ polarityWindowStart: evidence.start })
        .where(revision);
    },
  );
const separateGraphCall = (tx: FixtureTx, evidence: Evidence) => {
  runCitationGraphTransaction(
    (run) => run(tx),
    () => fence(evidence.revision),
  );
  // oxlint-disable-next-line citation-evidence-text-fence/citation-evidence-text-fence -- fixture: a separate graph callback does not own this mutation
  tx.update(caseLawCitations).set({ polarityConfidence: evidence.start });
};
const clear = (tx: FixtureTx) => {
  // expect-clean: citation-evidence-text-fence/citation-evidence-text-fence
  tx.update(caseLawCitations).set({ polarityWindowStart: null });
};
const raw = async (tx: FixtureTx, start: number) => {
  // oxlint-disable-next-line citation-evidence-text-fence/citation-evidence-text-fence -- fixture: raw SQL requires the same owner fence
  const mutation = sql`UPDATE case_law_citations SET polarity_window_start = ${start}`;
  await tx.execute(mutation);
};
export { unguarded, guarded, separateGraphCall, clear, raw };
