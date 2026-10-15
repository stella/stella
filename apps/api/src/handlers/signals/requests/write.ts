import type { Named } from "@gdp-ts/core";

import type { SIGNAL_KIND } from "@stll/api-contract/signals";

import type { Transaction } from "@/api/db/root";
import type { SafeId } from "@/api/lib/branded-types";
import { emitSignals } from "@/api/lib/signals/emit";
import type { NewSignal } from "@/api/lib/signals/emit";
import type { MayCreateSignalRequest } from "@/api/lib/signals/proofs/may-create-signal-request";

type EmitSignalRequestOptions<U, W, T, O> = {
  tx: Named<T, Transaction>;
  workspace: Named<W, SafeId<"workspace"> | null>;
  actor: Named<U, SafeId<"user">>;
  proof: MayCreateSignalRequest<NoInfer<U>, NoInfer<W>, NoInfer<T>, O>;
  signal: Omit<
    Extract<NewSignal, { kind: typeof SIGNAL_KIND.REQUEST_SUBMITTED }>,
    "workspaceId" | "createdByUserId"
  >;
};

export const emitSignalRequest = async <U, W, T, O>({
  tx,
  workspace,
  actor,
  proof,
  signal,
}: EmitSignalRequestOptions<U, W, T, O>) =>
  emitSignals({
    tx: tx.value,
    organizationId: proof.organizationId.value,
    signals: [
      { ...signal, workspaceId: workspace.value, createdByUserId: actor.value },
    ],
  });
