import { emitInfoSoudHearingSignals as recordSource } from "@/api/lib/scouts/infosoud-hearings";
import type { EmitInfoSoudHearingSignalsArgs } from "@/api/lib/scouts/infosoud-hearings";

export const emitInfoSoudHearingSignals = async (
  args: EmitInfoSoudHearingSignalsArgs,
): Promise<void> => {
  await recordSource(args);
};
