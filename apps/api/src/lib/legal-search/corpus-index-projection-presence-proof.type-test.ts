import type { Transaction } from "@/api/db/root";
import { CorpusProjectionPresenceProof } from "@/api/lib/legal-search/corpus-index-projection-engine";
import { proveAcceptedCorpusProjectionAppendsTx } from "@/api/lib/legal-search/corpus-index-projection-store";

const rejectedAtCompileTime = (outcome: unknown) => outcome;

// Compile-only: this function is never invoked.
export const presenceProofMistakes = async (
  tx: Transaction,
  proof: CorpusProjectionPresenceProof,
) => {
  const fields = {
    indexId: proof.indexId,
    revision: proof.revision,
    documentCount: proof.documentCount,
  };
  rejectedAtCompileTime(
    // @ts-expect-error Applying an append requires a presence census.
    await proveAcceptedCorpusProjectionAppendsTx(tx, {
      indexId: proof.indexId,
    }),
  );
  rejectedAtCompileTime(
    await proveAcceptedCorpusProjectionAppendsTx(tx, {
      indexId: proof.indexId,
      census: {
        // @ts-expect-error A revision and a count are not presence evidence.
        proofs: [{ revision: proof.revision, documentCount: 1 }],
        unproven: [],
      },
    }),
  );
  rejectedAtCompileTime(
    await proveAcceptedCorpusProjectionAppendsTx(tx, {
      indexId: proof.indexId,
      // @ts-expect-error An object literal cannot construct presence evidence.
      census: { proofs: [fields], unproven: [] },
    }),
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
