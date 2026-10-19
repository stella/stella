import type { SafeId } from "@/api/lib/branded-types";
import { resumeSignalsAfterGrant as resumeOwned } from "@/api/lib/signals/resume-after-grant";

type ResumeSignalsAfterGrantOptions = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};
export const resumeSignalsAfterGrant = async (
  options: ResumeSignalsAfterGrantOptions,
  dependencies?: Parameters<typeof resumeOwned>[1],
): Promise<void> => {
  await resumeOwned(options, dependencies);
};
