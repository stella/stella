import type { Named } from "@gdp-ts/core";

import type { Transaction } from "@/api/db/root";
import type { SafeId } from "@/api/lib/branded-types";
import type {
  MatterReadable,
  MatterWritable,
} from "@/api/lib/workspaces/matter-access-proof";

const readMatter = <U, M, T, O>({
  tx,
  matter,
  proof,
}: {
  tx: Named<T, Transaction>;
  matter: Named<M, SafeId<"workspace">>;
  proof: MatterReadable<U, M, T, O>;
}) => ({ tx, matter, proof });

const writeMatter = <U, M, T, O>({
  tx,
  matter,
  proof,
}: {
  tx: Named<T, Transaction>;
  matter: Named<M, SafeId<"workspace">>;
  proof: MatterWritable<U, M, T, O>;
}) => ({ tx, matter, proof });

export const matterAccessProofTypeChecks = <U, M, T, O, Other>(
  tx: Named<T, Transaction>,
  matter: Named<M, SafeId<"workspace">>,
  readProof: MatterReadable<U, M, T, O>,
  writeProof: MatterWritable<U, M, T, O>,
  otherTx: Named<Other, Transaction>,
  otherMatter: Named<Other, SafeId<"workspace">>,
) => {
  const accepted = writeMatter({ tx, matter, proof: writeProof });
  // @ts-expect-error Matter data requires evidence.
  readMatter({ tx, matter });
  // @ts-expect-error Evidence for one matter cannot read another.
  readMatter({ tx, matter: otherMatter, proof: readProof });
  // @ts-expect-error Evidence belongs to the transaction that checked it.
  readMatter({ tx: otherTx, matter, proof: readProof });
  // @ts-expect-error Read evidence does not permit writes.
  writeMatter({ tx, matter, proof: readProof });
  return accepted;
};
