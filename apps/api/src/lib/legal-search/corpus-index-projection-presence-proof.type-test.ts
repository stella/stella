import type { Transaction } from "@/api/db/root";
import { CorpusProjectionPresenceProof } from "@/api/lib/legal-search/corpus-index-projection-engine";
import { commitCorpusProjectionAppendTx } from "@/api/lib/legal-search/corpus-index-projection-store";

const rejectedAtCompileTime = (outcome: unknown) => outcome;

// Compile-only: this function is never invoked.
export const presenceProofMistakes = async (
  tx: Transaction,
  proof: CorpusProjectionPresenceProof,
  leaseToken: string,
) => {
  const fields = {
    indexId: proof.indexId,
    revision: proof.revision,
    documentCount: proof.documentCount,
  };
  rejectedAtCompileTime(
    // @ts-expect-error Applying an append requires presence evidence.
    await commitCorpusProjectionAppendTx(tx, { leaseToken }),
  );
  rejectedAtCompileTime(
    await commitCorpusProjectionAppendTx(tx, {
      // @ts-expect-error A revision and a count are not presence evidence.
      intentId: proof.revision,
      documentCount: proof.documentCount,
      leaseToken,
    }),
  );
  rejectedAtCompileTime(
    // @ts-expect-error An object literal cannot construct presence evidence.
    await commitCorpusProjectionAppendTx(tx, { proof: fields, leaseToken }),
  );
  // @ts-expect-error A spread copy of evidence is not evidence.
  const copied: CorpusProjectionPresenceProof = { ...proof }; // oxlint-disable-line typescript/no-misused-spread -- a spread copy must not type-check as evidence
  rejectedAtCompileTime(
    // @ts-expect-error Only the census holds the constructor's token.
    new CorpusProjectionPresenceProof(Symbol("forged"), proof.indexId, {
      revision: proof.revision,
      documentCount: proof.documentCount,
    }),
  );
  return copied;
};
