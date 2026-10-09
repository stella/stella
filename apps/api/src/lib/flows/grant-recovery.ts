import type { SafeId } from "@/api/lib/branded-types";
import { resumeFlowsAfterGrant as resumeOwned } from "@/api/lib/flows/resume-after-grant";

type ResumeFlowsAfterGrantOptions = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};
export const resumeFlowsAfterGrant = async (
  options: ResumeFlowsAfterGrantOptions,
  dependencies?: Parameters<typeof resumeOwned>[1],
): Promise<void> => {
  await resumeOwned(options, dependencies);
};
