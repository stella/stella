import type { SIGNAL_KIND } from "@stll/api-contract/signals";

import type { Transaction } from "@/api/db/root";
import type { SafeId } from "@/api/lib/branded-types";
import { emitSignals } from "@/api/lib/signals/emit";
import type { NewSignal } from "@/api/lib/signals/emit";
import type { Named } from "@/api/lib/signals/proofs/core";
import type { MayCreateSignalRequest } from "@/api/lib/signals/proofs/may-create-signal-request";

type EmitSignalRequestOptions<U, W, T> = {
  tx: Named<T, Transaction>;
  workspace: Named<W, SafeId<"workspace"> | null>;
  actor: Named<U, SafeId<"user">>;
  proof: MayCreateSignalRequest<NoInfer<U>, NoInfer<W>, NoInfer<T>>;
  signal: Omit<
    Extract<NewSignal, { kind: typeof SIGNAL_KIND.REQUEST_SUBMITTED }>,
    "workspaceId" | "createdByUserId"
  >;
};

export const emitSignalRequest = <U, W, T>({
  tx,
  workspace,
  actor,
  proof,
  signal,
}: EmitSignalRequestOptions<U, W, T>) =>
  emitSignals({
    tx: tx.value,
    organizationId: proof.organizationId,
    signals: [
      { ...signal, workspaceId: workspace.value, createdByUserId: actor.value },
    ],
  });
